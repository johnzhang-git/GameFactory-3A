# CardCollector 合约

链上卡牌所有权（ERC-1155 + 惰性铸造）。对应 [../docs/web3-integration.md](../docs/web3-integration.md) 的**阶段 2**。

## 快速开始

```bash
npx hardhat compile
npx hardhat test                                    # 25 个用例，真实 EVM 执行
SIGNER_ADDRESS=0x... npx hardhat run contracts/scripts/deploy.cjs
```

## 为什么这样设计（按省钱多少排序）

### 1. 惰性铸造 —— 工作室链上成本 ≈ $0

卡牌**只在玩家主动领取时**才铸造，且**由玩家付 gas**。后端只做 EIP-712 签名，从不发交易。

对比：若每次抽卡都上链，一轮约 670 次开箱 × 每个玩家，成本随玩家数线性增长。
惰性铸造把这项压到零——玩家不领取就什么都不发生。

### 2. ERC-1155 而非 ERC-721 —— 低一个数量级

```
tokenId = 卡牌身份（如 Slime）      → 全服共用，不可变
balance = 玩家持有该卡的副本数      → 就是游戏里的 copies
```

游戏里「抽到重复卡 → 副本数 +1」**恰好等于** `balanceOf` 增加 1，无需为每张卡铸独立 NFT。

### 3. 等级不上链 —— 避免状态更新交易

等级由副本数推导且频繁变化。写进链上元数据意味着每次升级一笔交易。链上只存 `tokenId` 与 `balance`，等级在链下计算。

## 凭证（Voucher）机制

后端签名，玩家提交，合约验证：

```solidity
struct Voucher {
    address to;        // 绑定领取人
    uint256 tokenId;
    uint256 amount;    // 玩家持该卡的【总数】，不是增量
    uint256 nonce;     // 一次性，防重放
    uint256 deadline;  // 过期时间
}
```

**`amount` 是总数而非增量**，这是关键设计：合约只铸造「总数 − 已铸造」的差额。
于是**重发或重放凭证至多只能补齐到该总数**，不可能双铸——这比累加增量容易推理得多。

### 三个必须理解的字段

| 字段 | 不这样会怎样 |
|---|---|
| `to` 绑定领取人 | 任何人看到凭证就能用它给自己铸 |
| `nonce` 一次性 | 同一张凭证可被反复提交，无限铸 |
| `deadline` | 泄露但未使用的凭证永久有效 |

### nonce 必须是随机的，不能是时间戳

`nonce` 曾用 `Math.floor(Date.now()/1000)`。**这是坏的**：签发一批凭证是同步循环，
同一秒内所有凭证会拿到**相同 nonce**。合约的 nonce 是全局消费的，于是
**玩家一次「领取全部卡牌」只能成功第一张，其余全被当作重放拒绝**。

已改为 256 位随机数。集成测试 `lets a player claim several cards from one response`
锁住该行为。

## 安全边界

**合约只做铸造。不持有资金、无可提取余额、无暂停、无 mint 角色。**
唯一的特权操作是 `setUri`（owner），因为元数据 URI 决定了钱包/市场渲染什么，
开放它等于允许任何人把卡面指向钓鱼页。

已覆盖的攻击场景（`test/CardCollector.cjs`）：

- 重放凭证
- 用他人凭证给自己铸
- 伪造签名
- 签名后篡改金额
- 过期凭证
- 跨合约部署复用（域分隔）
- 跨链复用

## 测试分四层

| 层 | 文件 | 证明什么 |
|---|---|---|
| 合约单元 | `test/CardCollector.cjs` | 合约自身的规则与攻击防护 |
| **跨边界** | `test/VoucherIntegration.cjs` | **服务端签的凭证，真实合约接受** |
| 重入 | `test/Reentrancy.cjs` + `test/ReentrantClaimer.sol` | 用**真实恶意接收方合约**验证 `_mint` 回调窗口不可利用 |
| 不变量 | `test/Invariants.cjs` | 总量守恒、卡牌独立、高水位行为 |

后者不是「没发现问题」，而是把性质**固定住**。其中
`documents that transfers strand the claimed high-water mark` 主动暴露了一个
设计张力，详见 [AUDIT.md](./AUDIT.md) F-2。

## 安全审查

**[AUDIT.md](./AUDIT.md)** —— 作者自查（Slither + 对抗性测试）。

> **它不是审计报告。** 独立审计的价值在于审查者不是写代码的人；同一个人的盲区不会
> 因为多跑几个工具而消失。该文档应作为交给专业审计方的输入，**不是上线的凭证**。

第二层是最容易漏掉的。合约测试用 ethers 自己签名，服务端测试只验证自己签名自洽——
**两者都通过，服务端仍可能签出每一张都被链上拒绝的凭证**，只要 EIP-712 域
（`name`/`version`/`chainId`/`verifyingContract`）或字段顺序与 Solidity 不一致。

`VoucherIntegration.cjs` 用真实的 `VoucherSigner` 签名，交给真实部署的合约，
是唯一能发现这类漂移的检查。

## 部署后

脚本会打印服务端需要的三个变量：

```
CHAIN_ID=31337
CHAIN_CONTRACT_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3
CHAIN_SIGNER_KEY=<CHAIN_SIGNER_KEY 对应地址的私钥>
```

**`CHAIN_SIGNER_KEY` 是主权密钥**：持有它即可无限铸造。生产环境必须放密钥管理服务，
绝不入库、不进镜像。它能签名但不能动钱——合约不持有任何资产。

未配置这三个变量时，`/chain/*` 接口返回 503，游戏其余部分不受影响。

## 端到端验证

```bash
npx hardhat node --port 8546 &   # 一条真实链
node tools/chain-e2e.mjs         # 部署 → 签发 → 铸造 → 链上对账
```

实测输出：

```
holding   2 cards
claimable 2 copies | available: true
vouchers  2
minted    2 ok, 0 failed
  card  3 Rat         chain=1 voucher=1
  card  1 Goblin      chain=1 voucher=1
re-claim  0 vouchers (expect 0)
CLAIM WORKS END TO END: YES
```

这是唯一同时覆盖合约、服务端签名、HTTP 与 calldata 编码的检查——每一层都有自己的测试，
但只有它能证明这些层**彼此接通**。

## 已知取舍

- **转账未禁用**：合约是标准 ERC-1155，玩家可自由转让。限制转让是游戏无法在代币
  离开后继续执行的策略，写进合约只是假象。
- **`uri()` 不替换 `{id}`**：OpenZeppelin 原样返回基础 URI，`{id}` 是钱包与市场
  自行展开的约定。直接读元数据的调用方需自行替换。
- **未审计**：仅铸造、不托管资金，损失面有限。有真实资金流入前应做审计。
- **`totalMinted` 不是供应上限**：它只是累计铸造量。总量是否封顶属产品决策，
  当前 `CARD_IDS` 共 25 张，tokenId 空间固定。
