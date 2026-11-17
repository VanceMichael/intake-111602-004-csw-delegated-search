# 地理目录检索查看器

用于检查授权来源的一份原始资料并留存接收凭据。当前提供资料预览、原件接收、凭据列表与摘要回读，资料源可以在本地独立运行。

## 环境与运行

使用 Node.js 22.23.4，无第三方运行包。安装、检查与测试：

```sh
npm ci --ignore-scripts --offline
npm run build
npm test
npm run demo
```

`demo` 临时启动来源和查看服务，展示当前资料并核对保存后的原件，再执行一次跨目录资料领取并打印覆盖与不确定项；结束时关闭所有监听并移除临时目录。不会连接外部来源。`test` 校验已有预览、资料控制、原件持久化与跨目录委托检索；测试通过只说明当前版本已有能力正常。

需要交互时分别运行 `npm run source` 与 `npm start`。来源默认监听本机 4310 端口，应用默认监听 4320；可用 `PORT`、`SOURCE_URL`、`DATA_DIR` 配置。`GET /preview` 获取预览，`POST /receipts` 接收当前资料，`GET /receipts` 查询凭据，`GET /objects/<摘要>` 回读原件。`POST /harvests` 执行一次跨目录资料领取并留存审计报告，`GET /harvests` 与 `GET /harvests/<编号>` 回查条件覆盖与不确定项。应用只允许配置到本机的资料服务。

## 目录

`source/` 负责资料源的发布日期和传输状态；`src/decode.mjs` 解释一份来源资料；`src/catalog.mjs` 管理不可变原件、接收凭据与跨目录报告；`src/harvest.mjs` 执行带委托回路保护的跨目录领取；`src/app.mjs` 提供查看服务。资料含义、来源控制与跨目录规则见 `docs/资料接口.md`。

## 容器

```sh
docker build -t csw-delegated-search .
docker run --rm --network none csw-delegated-search
```

镜像固定 Node.js 版本，构建期间不下载 npm 运行依赖。运行产生的原件保存在 `DATA_DIR`，不应写回来源文件。
