# Cloudflare Workers 部署教程

## 📦 什么是 Cloudflare Workers？

Cloudflare Workers 是一个无服务器平台，可以让你的代码运行在全球边缘节点上。对于我们的小说阅读器来说：

- ✅ **免费额度**：每天 10 万次请求
- ✅ **无需手机验证**：只需邮箱注册
- ✅ **全球加速**：自动选择最近的服务器
- ✅ **稳定可靠**：比公共代理更稳定

---

## 🚀 部署步骤（5 分钟完成）

### 1️⃣ 注册 Cloudflare 账号

1. 打开 https://dash.cloudflare.com/sign-up
2. 用邮箱注册（不需要手机号）
3. 验证邮箱后登录

### 2️⃣ 创建 Worker

1. 登录后，点击左侧菜单 **Workers & Pages**
2. 点击 **Create Application** 按钮
3. 选择 **Create Worker**
4. 给 Worker 起个名字，比如 `novel-proxy`（这个名字会成为你的域名一部分）
5. 点击 **Deploy** 按钮

### 3️⃣ 粘贴代码

1. 部署完成后，点击 **Edit Code** 按钮
2. 删除左侧编辑器里的所有默认代码
3. 打开本地的 `cloudflare-worker.js` 文件
4. 复制全部内容，粘贴到 Cloudflare 编辑器
5. 点击右上角 **Save and Deploy** 按钮

### 4️⃣ 获取 Worker 地址

部署成功后，你会看到一个地址，类似：

```
https://novel-proxy.你的用户名.workers.dev
```

**复制这个地址！**

### 5️⃣ 修改阅读器代码

现在需要修改 `app.js`，让它使用你的 Worker：

在 `app.js` 的 `startUrlParse()` 函数中，找到代理列表：

```javascript
const proxies = [
    { url: '', name: '直连' },
    { url: 'https://api.allorigins.win/get?url=', name: 'AllOrigins', parseJson: true },
    // ...
];
```

**在数组最前面添加你的 Worker**（第 2 项，在"直连"后面）：

```javascript
const proxies = [
    { url: '', name: '直连' },
    { url: 'https://novel-proxy.你的用户名.workers.dev/?url=', name: '私有代理 (推荐)' },
    { url: 'https://api.allorigins.win/get?url=', name: 'AllOrigins', parseJson: true },
    // ...
];
```

**记得替换成你自己的 Worker 地址！**

### 6️⃣ 推送到 GitHub

保存修改后，推送到 GitHub：

```bash
git add app.js
git commit -m "使用 Cloudflare Workers 代理"
git push origin main
```

---

## 🎉 完成！

现在你的阅读器会优先使用你自己的代理服务器，成功率会大大提高！

---

## 📊 查看使用统计

在 Cloudflare Workers 管理页面可以看到：
- 请求次数
- 成功率
- 响应时间

---

## ⚠️ 注意事项

1. **免费额度够用吗？**  
   每天 10 万次请求，对个人使用绰绰有余。

2. **域名会变吗？**  
   不会，一旦创建就固定了。

3. **需要维护吗？**  
   不需要，Cloudflare 会自动更新和维护。

4. **安全吗？**  
   代码开源透明，只转发请求，不存储任何数据。

---

## 🔧 高级配置（可选）

### 自定义域名

如果你有自己的域名，可以在 Cloudflare Workers 设置中绑定：

1. 点击 Worker 名称
2. 进入 **Triggers** 标签
3. 点击 **Add Custom Domain**
4. 输入域名（如 `api.yourdomain.com`）

### 添加请求日志

在代码中加入：

```javascript
console.log('请求来源:', origin);
console.log('目标 URL:', targetUrl);
```

然后在 Workers 管理页面的 **Logs** 标签可以看到实时日志。

---

## 🆘 遇到问题？

### 问题 1：部署后访问 404

**原因**：可能需要等待几秒钟生效  
**解决**：等待 30 秒后刷新

### 问题 2：请求失败

**原因**：Worker 地址配置错误  
**解决**：检查代理列表中的 URL 是否正确，末尾要有 `/?url=`

### 问题 3：仍然跨域错误

**原因**：Worker 代码中的 `allowedOrigins` 需要包含你的域名  
**解决**：检查 Worker 代码第 12-17 行，确保包含 `https://yyasat.github.io`

---

## 📚 相关链接

- Cloudflare Workers 文档：https://developers.cloudflare.com/workers/
- 免费额度说明：https://developers.cloudflare.com/workers/platform/pricing/

---

**祝你部署顺利！** 🎊