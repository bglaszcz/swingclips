package dev.swingclips.capture

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread

/** Finding the server (ServerFinder) on the JVM: ./gradlew :app:testDebugUnitTest. A fake server on 127.0.0.1. */
class ServerFinderTest {
    private lateinit var fake: ServerSocket
    private var body = """{"ms":1792851924727,"app":"swingclips"}"""

    @Before fun start() {
        fake = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        thread(isDaemon = true) {
            while (!fake.isClosed) {
                val s = runCatching { fake.accept() }.getOrNull() ?: break
                thread(isDaemon = true) {
                    s.use {
                        val request = it.getInputStream().bufferedReader().readLine() ?: ""
                        val ok = request.startsWith("GET /api/time ")
                        val bytes = (if (ok) body else "not here").toByteArray()
                        it.getOutputStream().write(("HTTP/1.1 ${if (ok) "200 OK" else "404 Not Found"}\r\n" +
                            "Content-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n").toByteArray() + bytes)
                    }
                }
            }
        }
    }

    @After fun stop() = fake.close()

    private val url get() = "http://127.0.0.1:${fake.localPort}"

    @Test fun whatCountsAsTheServer() {
        assertTrue(ServerFinder.isServer("""{"ms":1792851924727,"app":"swingclips"}"""))
        assertTrue(ServerFinder.isServer("""{"ms": 1792851924727}"""))   // a server from before "app"
        assertFalse(ServerFinder.isServer("""{"ms":1,"app":"camera"}"""))
        assertFalse(ServerFinder.isServer("""{"time":1}"""))
        assertFalse(ServerFinder.isServer("<html>router</html>"))
    }

    @Test fun networksAndPorts() {
        assertEquals("192.168.7", ServerFinder.networkOf("http://192.168.7.250:8000"))
        assertEquals("10.0.1", ServerFinder.networkOf("10.0.1.5"))
        assertNull(ServerFinder.networkOf("http://homeserver:8000"))
        assertEquals(8001, ServerFinder.portOf("http://192.168.7.250:8001/"))
        assertEquals(ServerFinder.PORT, ServerFinder.portOf("http://192.168.7.250"))
        assertEquals(listOf("192.168.86", "10.0.0", "192.168.7"),
            ServerFinder.networks("http://192.168.86.250:8000", listOf("192.168.86", "10.0.0"), listOf("192.168.7")))
        val r = ServerFinder.rounds(listOf("192.168.7", "10.0.0"), 8000)
        assertEquals(listOf("http://192.168.7.250:8000", "http://10.0.0.250:8000"), r[0])
        assertEquals(2 * 253, r[1].size)
        assertFalse(r[1].contains("http://192.168.7.250:8000"))
    }

    @Test fun ownNetworksArePrivate() {
        for (n in ServerFinder.ownNetworks()) assertFalse(n, n.startsWith("127.") || n.startsWith("169.254"))
    }

    @Test fun checkTellsTheServerFromAnotherApp() {
        assertTrue(ServerFinder.check(url))
        body = """{"ms":5,"app":"camera"}"""
        assertFalse(ServerFinder.check(url))
        assertFalse(ServerFinder.check("http://127.0.0.1:9", connectMs = 500))
    }

    @Test fun theSavedAddressFirst() {
        assertEquals(url, ServerFinder.find("$url/", own = emptyList(), home = emptyList(), default = "http://127.0.0.1:9"))
    }

    @Test fun foundByLookingRoundOffTheUsualHost() {
        // The saved address and the default don't answer; the server is on 127.0.0.1, not the usual host.
        val got = ServerFinder.find("http://127.0.0.250:${fake.localPort}", own = emptyList(), home = emptyList(),
            default = "http://127.0.0.2:9")
        assertEquals(url, got)
    }

    @Test fun notFoundAnywhere() {
        fake.close()
        assertNull(ServerFinder.firstAnswering(listOf("http://127.0.0.1:9", "http://127.0.0.3:9")))
    }
}
