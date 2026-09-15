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
| `CHAIN_SIGNER_KEY` | — | 原始私钥。**仅限开发**，生产用 KMS |
| `CHAIN_KEY_PROVIDER` | `env` | `env` 或 `kms` |
| `CHAIN_KMS_KEY_ID` | — | KMS 密钥 id/ARN（`kms` 模式） |
| `CHAIN_SIGNER_ADDRESS` | — | 签名地址，`kms` 模式必填 |
| `CHAIN_VERIFY_KEY` | `true` | 启动时校验密钥与地址匹配 |
| `AWS_REGION` | — | KMS 客户端区域 |

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

## 签名密钥

`CHAIN_SIGNER_KEY` 是**唯一泄露即可无限铸造**的秘密。本地开发用环境变量可以，
生产必须换成 KMS：

```bash
CHAIN_KEY_PROVIDER=kms
CHAIN_KMS_KEY_ID=arn:aws:kms:...:key/...
CHAIN_SIGNER_ADDRESS=0x...        # 必填，见下
npm install @aws-sdk/client-kms   # 仅 KMS 模式需要
```

密钥须为 `ECC_SECG_P256K1` + `SIGN_VERIFY`（即 secp256k1，以太坊用的曲线）。

### 为什么 KMS 不能直接接

托管 KMS 的 ECDSA 有三个会让**每一张凭证在链上失败、而本地测试全绿**的陷阱：

| 陷阱 | 后果 | 处理 |
|---|---|---|
| KMS 返回 **DER**，以太坊要 `r‖s‖v` | DER 是嵌套 TLV、整数变长，不能按固定偏移切 | `parseDerSignature` 完整解析，含长格式长度与符号填充 |
| KMS **不归一化 `s`** | OpenZeppelin 按 EIP-2 拒绝 high-s，链上直接 revert | 超过 `n/2` 时取 `n−s` |
| KMS **不返回 recovery id** | 没有 `v` 就无法还原签名者 | 对 27/28 两候选试还原，与预期地址比对 |

第二项是最阴险的：**viem 自己的签名器总是输出 low-s**，所以用 viem 伪造 KMS 的测试
永远发现不了——本地用原始私钥一切正常，生产用 KMS 则每笔都 revert。
`tests/key-source.spec.js` 用真实密钥手工构造 high-s 签名来覆盖这一点。

`CHAIN_SIGNER_ADDRESS` 在 KMS 模式**必填**：AWS 不提供非对称密钥的地址，
而 recovery id 必须对照一个已知地址才能确定。声明它还有个附带好处——
密钥 id 指错时启动即报错，而不是等到玩家领取失败。

### 启动自检

服务启动时会用固定的 digest 签一次并还原地址（`CHAIN_VERIFY_KEY=false` 可关）。
不匹配就直接启动失败并打印两个地址。否则这类配置错误只会表现为
「领取功能坏了」，日志里什么都没有。

### 端到端验证

```bash
npx hardhat compile
node tools/kms-e2e.mjs
```

用**返回 DER** 的 KMS stub 走完整链路，最终由真实合约验证签名被接受：

```
key source verified
vouchers  2
minted    2 ok, 0 failed
  card  9 chain=1 voucher=1
KMS-SIGNED VOUCHERS MINT ON CHAIN: YES
```

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
