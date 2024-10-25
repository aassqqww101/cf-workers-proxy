function logError(request, message) {
  console.error(
    `${message}, clientIp: ${request.headers.get(
      "cf-connecting-ip"
    )}, user-agent: ${request.headers.get("user-agent")}, url: ${request.url}`
  );
}

function createNewRequest(request, url, proxyHostname, proxyPort, originHostname, originPort) {
  const newRequestHeaders = new Headers(request.headers);
  const proxyUrl = proxyHostname+":"+proxyPort;
  const originUrl = originHostname+":"+originPort;
  for (const [key, value] of newRequestHeaders) {
    if (value.includes(originUrl)) {
      newRequestHeaders.set(
        key,
        value.replace(
          new RegExp(`(?<!\\.)\\b${originUrl}\\b`, "g"),
          proxyUrl
        )
      );
    }
  }
  return new Request(url.toString(), {
    method: request.method,
    headers: newRequestHeaders,
    body: request.body,
  });
}

function setResponseHeaders(
  originalResponse,
  proxyHostname,
  proxyPort,
  originHostname,
  originPort,
  DEBUG
) {
  const newResponseHeaders = new Headers(originalResponse.headers);
  const proxyUrl = proxyHostname+":"+proxyPort;
  const originUrl = originHostname+":"+originPort;
  for (const [key, value] of newResponseHeaders) {
    if (value.includes(proxyUrl)) {
      newResponseHeaders.set(
        key,
        value.replace(
          new RegExp(`(?<!\\.)\\b${proxyUrl}\\b`, "g"),
          originUrl
        )
      );
    }
  }
  if (DEBUG) {
    newResponseHeaders.delete("content-security-policy");
  }
  return newResponseHeaders;
}

/**
 * 替换内容
 * @param originalResponse 响应
 * @param proxyHostname 代理地址 hostname
 * @param pathnameRegex 代理地址路径匹配的正则表达式
 * @param originHostname 替换的字符串
 * @returns {Promise<*>}
 */
async function replaceResponseText(
  originalResponse,
  proxyHostname,
  proxyPort,
  pathnameRegex,
  originHostname,
  originPort
) {
  let text = await originalResponse.text();
  const proxyUrl = proxyHostname+":"+proxyPort;
  const originUrl = originHostname+":"+originPort;
  if (pathnameRegex) {
    pathnameRegex = pathnameRegex.replace(/^\^/, "");
    return text.replace(
      new RegExp(`((?<!\\.)\\b${proxyUrl}\\b)(${pathnameRegex})`, "g"),
      `${originUrl}$2`
    );
  } else {
    return text.replace(
      new RegExp(`(?<!\\.)\\b${proxyUrl}\\b`, "g"),
      originUrl
    );
  }
}

async function nginx() {
  return `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>
html { color-scheme: light dark; }
body { width: 35em; margin: 0 auto;
font-family: Tahoma, Verdana, Arial, sans-serif; }
</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and
working. Further configuration is required.</p>

<p>For online documentation and support please refer to
<a href="http://nginx.org/">nginx.org</a>.<br/>
Commercial support is available at
<a href="http://nginx.com/">nginx.com</a>.</p>

<p><em>Thank you for using nginx.</em></p>
</body>
</html>`;
}

export default {
  async fetch(request, env, ctx) {
    try {
      const {
        PROXY_HOSTNAME,
        PROXY_PORT = 80,
        PROXY_PROTOCOL = "https",
        PATHNAME_REGEX,
        UA_WHITELIST_REGEX,
        UA_BLACKLIST_REGEX,
        URL302,
        IP_WHITELIST_REGEX,
        IP_BLACKLIST_REGEX,
        REGION_WHITELIST_REGEX,
        REGION_BLACKLIST_REGEX,
        DEBUG = false,
      } = env;
      const url = new URL(request.url);
      const originHostname = url.hostname;
      const originPort = url.port;
      if (
        !PROXY_HOSTNAME ||
        (PATHNAME_REGEX && !new RegExp(PATHNAME_REGEX).test(url.pathname)) ||
        (UA_WHITELIST_REGEX &&
          !new RegExp(UA_WHITELIST_REGEX).test(
            request.headers.get("user-agent").toLowerCase()
          )) ||
        (UA_BLACKLIST_REGEX &&
          new RegExp(UA_BLACKLIST_REGEX).test(
            request.headers.get("user-agent").toLowerCase()
          )) ||
        (IP_WHITELIST_REGEX &&
          !new RegExp(IP_WHITELIST_REGEX).test(
            request.headers.get("cf-connecting-ip")
          )) ||
        (IP_BLACKLIST_REGEX &&
          new RegExp(IP_BLACKLIST_REGEX).test(
            request.headers.get("cf-connecting-ip")
          )) ||
        (REGION_WHITELIST_REGEX &&
          !new RegExp(REGION_WHITELIST_REGEX).test(
            request.headers.get("cf-ipcountry")
          )) ||
        (REGION_BLACKLIST_REGEX &&
          new RegExp(REGION_BLACKLIST_REGEX).test(
            request.headers.get("cf-ipcountry")
          ))
      ) {
        logError(request, "Invalid");
        return URL302
          ? Response.redirect(URL302, 302)
          : new Response(await nginx(), {
              headers: {
                "Content-Type": "text/html; charset=utf-8",
              },
            });
      }
      url.host = PROXY_HOSTNAME;
      url.port = PROXY_PORT;
      url.protocol = PROXY_PROTOCOL;
      const newRequest = createNewRequest(
        request,
        url,
        PROXY_HOSTNAME,
        PROXY_PORT,
        originHostname,
        originPort
      );
      const originalResponse = await fetch(newRequest);
      const newResponseHeaders = setResponseHeaders(
        originalResponse,
        PROXY_HOSTNAME,
        PROXY_PORT,
        originHostname,
        originPort
        DEBUG
      );
      const contentType = newResponseHeaders.get("content-type") || "";
      let body;
      if (contentType.includes("text/")) {
        body = await replaceResponseText(
          originalResponse,
          PROXY_HOSTNAME,
          PROXY_PORT,
          PATHNAME_REGEX,
          originHostname,
          originPort
        );
      } else {
        body = originalResponse.body;
      }
      return new Response(body, {
        status: originalResponse.status,
        headers: newResponseHeaders,
      });
    } catch (error) {
      logError(request, `Fetch error: ${error.message}`);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};
