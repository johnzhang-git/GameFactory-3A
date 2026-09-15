# 后端服务（阶段 1）

卡牌收集游戏的权威后端：**钱包登录 + 持久化存档 + 服务端裁决的抽卡**。

对应 [../docs/web3-integration.md](../docs/web3-integration.md) 的**阶段 1**——完全不涉及链，
但它是让「玩家拥有这些卡片」这句话**成立**的前提：在此之前游戏没有任何存档，刷新即清零。

## 快速开始

```bash
npm install
npm start          # 默认 http://127.0.0.1:8787
npm test           # 19 个用例，含登录、存档、防作弊
```

零配置即可运行：SQLite 文件默认落在 `server/data.sqlite`，监听回环地址。

## 解决什么问题

| 之前 | 现在 |
|---|---|
| 刷新页面即丢失全部收藏 | 存档在服务端，按钱包地址持久化 |
| 抽卡随机数种子来自前端，**可预测** | 抽卡在服务端执行，用加密安全随机源 |
| 无账号体系，无法归属资产 | 钱包地址即账号（SIWE，无密码） |
| 客户端可任改金币/收藏 | 所有状态变更由服务端裁决并校验 |

## API

除 `/health` 外均需 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 存活检查，无需认证 |
| `POST` | `/auth/nonce` | 下发一次性登录 nonce（body: `{address}`） |
| `POST` | `/auth/verify` | 校验签名消息，签发会话 token（body: `{message, signature}`） |
| `POST` | `/auth/logout` | 注销当前会话 |
| `GET` | `/auth/me` | 返回当前登录地址 |
| `GET` | `/game/state` | 存档（自动补发离线收益） |
| `POST` | `/game/buy` | 买普通箱（`{gold:true}` 买黄金箱） |
| `POST` | `/game/open` | 开箱，返回抽卡结果（`{gold:true}` 开黄金箱） |
| `POST` | `/game/prestige` | 转生 |
| `POST` | `/game/tick` | 补发指定秒数的收益（body: `{seconds}`） |

### 登录流程

```js
// 1. 取 nonce
const { nonce } = await post('/auth/nonce', { address });

// 2. 用钱包签名一条 SIWE 消息（EIP-4361）
const message = createSiweMessage({ address, chainId: 1, domain, nonce, uri, version: '1' });
const signature = await wallet.signMessage(message);

// 3. 换 token
const { token } = await post('/auth/verify', { message, signature });
```

## 设计要点

### 钱包地址即账号

没有密码、邮箱、注册流程。签名证明地址控制权，那就是全部身份模型。
会话 token 在数据库里**只存哈希**，库泄露不会直接交出可用凭证。

### 抽卡在服务端

原实现用 `createSeededRandom`，种子来自客户端参数——同一 seed 必然抽出同样的结果，
玩家可以预测、也可以反复重抽。现在 rarity 与卡牌由服务端用 `crypto.randomBytes` 决定
（`src/rng.js`），客户端只能请求、不能影响。

游戏规则本身**没有重写**：`@a3game/card-collector/rules` 是按 headless 设计的纯逻辑模块，
后端直接复用，只是把结果持久化。

### 每个请求独立载入/保存

不保留内存会话状态。存档是唯一真相，所以不存在「客户端与服务端状态不同步」，
也不存在对陈旧副本操作的可能。

### 时间由服务端封顶

`maxOfflineSeconds`（默认 8 小时）同时限制两件事：
离线补发收益的上限，以及客户端单次 `tick` 能请求的秒数。
否则一个伪造的时间戳就能凭空铸出任意金币。

## 配置

全部通过环境变量，无需改代码：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 绑定地址 |
| `DB_PATH` | `server/data.sqlite` | SQLite 路径，`:memory:` 用于测试 |
| `SESSION_SECRET` | 每次启动随机 | **不设置则重启后所有会话失效**（安全默认） |
| `SESSION_TTL_MS` | 7 天 | 会话有效期 |
| `MAX_OFFLINE_SECONDS` | 28800（8h） | 离线收益与 tick 的上限 |
| `CORS_ORIGIN` | `*` | 前端来源，**上线前应收紧** |
| `SIWE_RPC_URL` | 公共节点 | 仅合约钱包验签时需要 |

## 前端接入

游戏前端通过 `packages/card-collector/src/{api-client,session,wallet}.js` 接入。

**前端不强制连接**：未连接钱包时是纯本地玩法（不需要本服务），连接后切换为服务端权威。
这样 demo 与现有 playtest 仍可直接跑，也便于后端独立上线。

```js
import { startCardCollector } from '@a3game/card-collector';

// 指向后端；省略则连当前源（同域部署时用）
await startCardCollector({ apiBaseUrl: 'http://127.0.0.1:8787' });
```

启动后自动恢复已存会话（token 存于 `localStorage`），无需重复签名。

## 尚未实现

- 链上领取（惰性铸造 ERC-1155）——`docs/web3-integration.md` §7 阶段 2
- 生产部署（HTTPS、反向代理、进程守护）
- 速率限制

## 目录

```
server/
├── src/
│   ├── index.js         # 进程入口：启动、打印、优雅退出
│   ├── server.js        # HTTP 装配与错误渲染（测试直接用它起临时端口）
│   ├── routes.js        # 路由表与请求体解析
│   ├── auth.js          # SIWE 登录与会话
│   ├── store.js         # SQLite：三个表
│   ├── game-service.js  # 复用游戏规则，裁决每次操作
│   ├── rng.js           # 加密安全随机源
│   ├── config.js        # 环境变量配置
│   └── errors.js        # 带状态码的错误
└── tests/server.spec.js # 19 个用例
```
