package dev.swingclips.capture

import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.net.URL
import java.util.concurrent.Callable
import java.util.concurrent.ExecutorCompletionService
import java.util.concurrent.Executors

/**
 * Finding the home server when the address saved on this phone stops answering (a new router, another
 * subnet: in Oct 2026 it moved from 192.168.86.250 to 192.168.7.250). Android can't look up Windows PC
 * names, so the phone looks round: the network of the address it had, its own Wi-Fi network and
 * [HOME_NETWORKS] (where the server lives: other subnets and VLANs reach it through the router), host
 * [HOST] first on each, then every other one. The server is whatever answers GET /api/time with
 * {"ms": ...} (and "app": "swingclips"). The sim laptop's scripts (relay/golf-common.ps1) and the night
 * worker (server/findserver.py) look the same way.
 */
object ServerFinder {
    const val DEFAULT = "http://192.168.7.250:8000"
    /** Networks looked round besides the phone's own: the first three numbers of a /24. */
    val HOME_NETWORKS = listOf("192.168.7")
    /** The server's usual last number (reserved for it in the router): tried first on every network. */
    const val HOST = 250
    const val PORT = 8000
    private const val SWEEP_CONNECT_MS = 500
    private const val CHECK_CONNECT_MS = 3000
    private const val READ_MS = 2000
    private const val THREADS = 48

    /** Whether a GET /api/time answer is a SwingClips server's (a regex: unit tests have no org.json). */
    fun isServer(body: String): Boolean {
        if (!Regex("\"ms\"\\s*:\\s*-?\\d").containsMatchIn(body)) return false
        val app = Regex("\"app\"\\s*:\\s*\"([^\"]*)\"").find(body)?.groupValues?.get(1)
        return app == null || app == "swingclips"
    }

    /** "192.168.7" from "http://192.168.7.250:8000" or "192.168.7.250"; null for a name. */
    fun networkOf(address: String?): String? =
        Regex("^(?:https?://)?(\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})\\.\\d{1,3}(?::\\d+)?/?$")
            .find(address?.trim() ?: "")?.groupValues?.get(1)

    fun portOf(url: String?): Int =
        Regex("^(?:https?://)?[^/:]+:(\\d+)").find(url?.trim() ?: "")?.groupValues?.get(1)?.toIntOrNull() ?: PORT

    /** The networks to look round, in order and once each: the last address's, the phone's own, the home ones. */
    fun networks(last: String?, own: List<String>, home: List<String> = HOME_NETWORKS): List<String> =
        (listOfNotNull(networkOf(last)) + own + home).distinct()

    /** The addresses to try, in two rounds: [host] on each network, then every other one. */
    fun rounds(nets: List<String>, port: Int, host: Int = HOST): List<List<String>> = listOf(
        nets.map { "http://$it.$host:$port" },
        nets.flatMap { n -> (1..254).filter { it != host }.map { "http://$n.$it:$port" } })

    /** The phone's own networks: its private IPv4 addresses (the Wi-Fi's), not loopback or link-local. */
    fun ownNetworks(): List<String> = runCatching {
        NetworkInterface.getNetworkInterfaces().toList().filter { it.isUp && !it.isLoopback }
            .flatMap { it.inetAddresses.toList() }
            .filterIsInstance<Inet4Address>()
            .filter { it.isSiteLocalAddress }
            .mapNotNull { networkOf(it.hostAddress) }
            .distinct()
    }.getOrDefault(emptyList())

    /** Whether the server answers at [url]. */
    fun check(url: String, connectMs: Int = CHECK_CONNECT_MS, readMs: Int = READ_MS): Boolean = try {
        val c = URL(url.trimEnd('/') + "/api/time").openConnection() as HttpURLConnection
        try {
            c.connectTimeout = connectMs
            c.readTimeout = readMs
            c.responseCode == 200 && isServer(c.inputStream.bufferedReader().use { it.readText() }.take(4096))
        } finally {
            c.disconnect()
        }
    } catch (e: Exception) {
        false
    }

    private fun opens(url: String, connectMs: Int): Boolean = try {
        val u = URL(url)
        Socket().use { it.connect(InetSocketAddress(u.host, if (u.port > 0) u.port else PORT), connectMs) }
        true
    } catch (e: Exception) {
        false
    }

    /** The first of [urls] where the server answers, many tried at once; null if none does. */
    fun firstAnswering(urls: List<String>, threads: Int = THREADS, connectMs: Int = SWEEP_CONNECT_MS): String? {
        if (urls.isEmpty()) return null
        val pool = Executors.newFixedThreadPool(minOf(threads, urls.size)) { r ->
            Thread(r, "server-finder").apply { isDaemon = true }
        }
        try {
            val done = ExecutorCompletionService<String?>(pool)
            for (u in urls) done.submit(Callable { if (opens(u, connectMs) && check(u, connectMs)) u else null })
            repeat(urls.size) {
                done.take().get()?.let { return it }
            }
            return null
        } finally {
            pool.shutdownNow()
        }
    }

    /**
     * The server's address: [last] or [default] if either answers, else found by looking round (a few
     * seconds: run it off the main thread); null when it isn't found anywhere.
     */
    fun find(last: String?, own: List<String> = ownNetworks(), home: List<String> = HOME_NETWORKS,
             default: String = DEFAULT, host: Int = HOST): String? {
        for (u in listOfNotNull(last?.trim()?.trimEnd('/')?.takeIf { it.isNotEmpty() }, default).distinct()) {
            if (check(u)) return u
        }
        val from = last?.takeIf { it.isNotBlank() } ?: default
        for (urls in rounds(networks(from, own, home), portOf(from), host)) firstAnswering(urls)?.let { return it }
        return null
    }
}
