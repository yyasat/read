/**
 * Cloudflare Worker - 小说网站 CORS 代理
 * 部署到 Cloudflare Workers 后可绕过浏览器跨域限制
 */

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  // 允许的请求来源（你的 GitHub Pages 域名）
  const allowedOrigins = [
    'https://yyasat.github.io',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'null' // 本地文件测试
  ];
  
  const origin = request.headers.get('Origin');
  
  // 处理 OPTIONS 预检请求
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': allowedOrigins.includes(origin) ? origin : allowedOrigins[0],
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, User-Agent',
        'Access-Control-Max-Age': '86400'
      }
    });
  }
  
  // 只允许 GET 和 POST 请求
  if (request.method !== 'GET' && request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  
  try {
    // 从查询参数中获取目标 URL
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');
    
    if (!targetUrl) {
      return new Response(
        JSON.stringify({ error: '缺少 url 参数' }), 
        { 
          status: 400,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        }
      );
    }
    
    // 验证目标 URL 格式
    let target;
    try {
      target = new URL(targetUrl);
    } catch {
      return new Response(
        JSON.stringify({ error: '无效的 URL 格式' }), 
        { 
          status: 400,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        }
      );
    }
    
    // 构建代理请求
    const proxyHeaders = new Headers();
    proxyHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    proxyHeaders.set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8');
    proxyHeaders.set('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');
    proxyHeaders.set('Referer', target.origin + '/');
    
    // 发起代理请求
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: proxyHeaders,
      redirect: 'follow'
    });
    
    // 读取响应内容
    const content = await response.text();
    
    // 返回结果，添加 CORS 头
    return new Response(content, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': allowedOrigins.includes(origin) ? origin : allowedOrigins[0],
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, User-Agent',
        'Cache-Control': 'public, max-age=3600'
      }
    });
    
  } catch (error) {
    return new Response(
      JSON.stringify({ 
        error: '代理请求失败', 
        message: error.message 
      }), 
      { 
        status: 500,
        headers: { 
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': allowedOrigins.includes(origin) ? origin : allowedOrigins[0]
        }
      }
    );
  }
}
