package com.xingheyuzhuan.shiguangschedule.ui.schoolselection.web

import android.util.Log
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import io.ktor.client.HttpClient
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.headers
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsChannel
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.content.ByteArrayContent
import io.ktor.http.parsing.ParseException
import io.ktor.http.parseHeaderValue
import io.ktor.http.takeFrom
import io.ktor.utils.io.jvm.javaio.toInputStream
import kotlinx.coroutines.runBlocking
import java.net.URI
import java.util.Collections

/**
 * WebView 请求拦截器
 * 用于过滤特定指纹 Header (如 X-Requested-With) 并接管 XHR/Fetch POST 数据流
 */
class WebViewRequestInterceptor {
    companion object {
        private val ktorClientNoRedirects = HttpClient {
            followRedirects = false
            install(HttpTimeout) {
                connectTimeoutMillis = 30_000
                requestTimeoutMillis = 60_000
                socketTimeoutMillis = 60_000
            }
        }

        private val ktorClientWithRedirects = HttpClient {
            followRedirects = true
            install(HttpTimeout) {
                connectTimeoutMillis = 30_000
                requestTimeoutMillis = 60_000
                socketTimeoutMillis = 60_000
            }
        }

        private val postBodyRegistry = Collections.synchronizedMap(mutableMapOf<String, RegisteredPostData>())

        fun registerPostData(id: String, body: String, contentType: String) {
            postBodyRegistry[id] = RegisteredPostData(body, contentType)
        }

        private data class RegisteredPostData(val body: String, val contentType: String)
    }

    private val cookieManager = CookieManager.getInstance()

    fun intercept(request: WebResourceRequest, isDesktopMode: Boolean): WebResourceResponse? {
        val rawUrl = request.url.toString()

        // 基础校验：只处理 http/https 请求
        if (!rawUrl.startsWith("http")) return null

        val requestIdHeader = request.requestHeaders["X-WebView-Post-Id"]
        val requestIdParam = request.url.getQueryParameter("_webview_post_id")
        val requestId = requestIdHeader ?: requestIdParam

        val isMainFrameGet = request.isForMainFrame && request.method.equals("GET", ignoreCase = true)
        val hasPostId = requestId != null

        // 关键过滤逻辑：
        // 1. 如果是主页面导航 GET 请求，必须拦截并剔除 Android WebView 默认附带的 X-Requested-With 请求头，
        //    防止教务系统将其误判为 Ajax 请求而返回 {"flag1":2,"msgContent":"请先登录系统"}。
        // 2. 如果是注册了 POST ID 的 XHR/Fetch 请求，接管并转发数据。
        // 3. 其他请求（普通图片/CSS/JS 以及传统的原生 POST 表单提交）放行给原生网络栈，确保登录表单与原生会话正常。
        if (!isMainFrameGet && !hasPostId) {
            return null
        }

        // 剥离内部凭据 Query 参数，恢复真实的目标请求 URL
        val url = if (requestIdParam != null) {
            val uriBuilder = request.url.buildUpon().clearQuery()
            request.url.queryParameterNames.forEach { name ->
                if (name != "_webview_post_id") {
                    request.url.getQueryParameters(name).forEach { value ->
                        uriBuilder.appendQueryParameter(name, value)
                    }
                }
            }
            uriBuilder.build().toString()
        } else {
            rawUrl
        }

        val registeredData = requestId?.let { postBodyRegistry.remove(it) }

        if (request.method.uppercase() != "GET" && registeredData == null) {
            return null
        }

        val client = if (request.isForMainFrame) ktorClientNoRedirects else ktorClientWithRedirects

        try {
            return runBlocking {
                val response = client.request {
                    this.url.takeFrom(url)
                    this.method = HttpMethod.parse(request.method)

                    if (registeredData != null) {
                        val rawContentType = registeredData.contentType.ifBlank { "application/x-www-form-urlencoded" }
                        val parsedContentType = try {
                            ContentType.parse(rawContentType)
                        } catch (e: Exception) {
                            ContentType.Application.FormUrlEncoded
                        }
                        setBody(ByteArrayContent(registeredData.body.toByteArray(Charsets.UTF_8), parsedContentType))
                    }

                    headers {
                        request.requestHeaders.forEach { (key, value) ->
                            // 剔除 X-Requested-With 防止被反爬或强智教务误判为异步 Ajax 请求
                            // 剔除 Content-Length 与 Host 避免 Ktor 冲突
                            if (!key.equals("X-Requested-With", ignoreCase = true) &&
                                !key.equals("X-WebView-Post-Id", ignoreCase = true) &&
                                !key.equals("Content-Length", ignoreCase = true) &&
                                !key.equals("Host", ignoreCase = true)) {
                                append(key, value)
                            }
                        }

                        // 如果是电脑模式，确保 Header 中的 User-Agent 也使用桌面端 UA
                        if (isDesktopMode) {
                            remove(HttpHeaders.UserAgent)
                            append(HttpHeaders.UserAgent, DESKTOP_USER_AGENT)
                        }

                        val cookies = cookieManager.getCookie(url)
                        if (!cookies.isNullOrEmpty()) {
                            append(HttpHeaders.Cookie, cookies)
                        }
                    }
                }

                // 同步 Set-Cookie 到 WebView 容器
                response.headers.getAll(HttpHeaders.SetCookie)?.forEach { cookieStr ->
                    cookieManager.setCookie(url, cookieStr)
                }
                cookieManager.flush()

                val statusCode = response.status.value

                // 处理 3xx 重定向
                if (statusCode in 300..399) {
                    if (request.isForMainFrame) {
                        val location = response.headers[HttpHeaders.Location]
                        if (location != null) {
                            val absoluteLocation = resolveAbsoluteUrl(url, location)
                            // 双向同步 Cookie 到目标 URL
                            response.headers.getAll(HttpHeaders.SetCookie)?.forEach { cookieStr ->
                                cookieManager.setCookie(absoluteLocation, cookieStr)
                            }
                            cookieManager.flush()

                            val html = "<!DOCTYPE html><html><head><meta http-equiv=\"refresh\" content=\"0;url=$absoluteLocation\"></head><body><script>window.location.replace('$absoluteLocation');</script></body></html>"
                            return@runBlocking WebResourceResponse(
                                "text/html",
                                "UTF-8",
                                200,
                                "OK",
                                mapOf("Cache-Control" to "no-cache"),
                                html.byteInputStream()
                            )
                        }
                    }
                    return@runBlocking null
                }

                val contentTypeHeader = response.headers[HttpHeaders.ContentType]
                var mimeType = "text/html"
                var encoding = "UTF-8"

                if (!contentTypeHeader.isNullOrBlank()) {
                    try {
                        val parsedHeader = parseHeaderValue(contentTypeHeader)
                        if (parsedHeader.isNotEmpty()) {
                            mimeType = parsedHeader[0].value.substringBefore(";")
                            val charsetParam = parsedHeader[0].params.find { it.name.equals("charset", ignoreCase = true) }
                            if (charsetParam != null) {
                                encoding = charsetParam.value
                            }
                        }
                    } catch (e: ParseException) {
                        mimeType = contentTypeHeader.substringBefore(";")
                        if (contentTypeHeader.contains("charset=")) {
                            encoding = contentTypeHeader.substringAfter("charset=").substringBefore(";")
                        }
                    }
                }

                // 防呆拦截：如果强智教务由于某种原因返回了 {"flag1":2,"msgContent":"请先登录系统"} 的纯文本/JSON，
                // 且当前是主页面导航，自动将其重定向到该系统的统一登录页面 /jsxsd/
                if (request.isForMainFrame && url.contains("/jsxsd/")) {
                    val responseBytes = response.bodyAsChannel().toInputStream().readBytes()
                    val responseStr = String(responseBytes, Charsets.UTF_8)
                    if (responseStr.contains("\"flag1\":2") || responseStr.contains("\"flag\":2")) {
                        val loginUrl = resolveAbsoluteUrl(url, "/jsxsd/")
                        val redirectHtml = "<!DOCTYPE html><html><head><meta http-equiv=\"refresh\" content=\"0;url=$loginUrl\"></head><body><script>window.location.replace('$loginUrl');</script></body></html>"
                        return@runBlocking WebResourceResponse(
                            "text/html",
                            "UTF-8",
                            200,
                            "OK",
                            mapOf("Cache-Control" to "no-cache"),
                            redirectHtml.byteInputStream()
                        )
                    }

                    val responseHeadersMap = mutableMapOf<String, String>()
                    response.headers.forEach { name, values ->
                        if (!name.equals("Content-Encoding", ignoreCase = true)) {
                            responseHeadersMap[name] = values.joinToString(", ")
                        }
                    }

                    return@runBlocking WebResourceResponse(
                        mimeType,
                        encoding,
                        statusCode,
                        response.status.description.ifBlank { "OK" },
                        responseHeadersMap,
                        responseBytes.inputStream()
                    )
                }

                val responseHeadersMap = mutableMapOf<String, String>()
                response.headers.forEach { name, values ->
                    if (!name.equals("Content-Encoding", ignoreCase = true)) {
                        responseHeadersMap[name] = values.joinToString(", ")
                    }
                }

                val inputStream = response.bodyAsChannel().toInputStream()

                WebResourceResponse(
                    mimeType,
                    encoding,
                    statusCode,
                    response.status.description.ifBlank { "OK" },
                    responseHeadersMap,
                    inputStream
                )
            }
        } catch (e: Exception) {
            Log.e("WebViewInterceptor", "Error intercepting request: $url", e)
            return null
        }
    }

    private fun resolveAbsoluteUrl(baseUrl: String, location: String): String {
        return try {
            URI(baseUrl).resolve(location).toString()
        } catch (e: Exception) {
            location
        }
    }
}

/**
 * JSBridge 注入桥接，供 JS 侧暂存 POST Body 数据
 */
class WebPostBridge {
    @JavascriptInterface
    fun register(id: String, body: String, type: String) {
        WebViewRequestInterceptor.registerPostData(id, body, type)
    }
}
