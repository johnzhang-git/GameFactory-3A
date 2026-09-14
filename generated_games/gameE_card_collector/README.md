# 卡牌收集游戏（gameE_card_collector）

一个基于 three.js 的放置/收集类小游戏：**买宝箱 → 开箱抽卡 → 卡牌周期产金币 → 金币再买宝箱**。

## 玩法

| 操作 | 效果 |
|---|---|
| 按 `B` 或点「Buy Chest」按钮 | 花金币买一个普通宝箱 |
| 按 `Space` 或点「Open Chest」按钮 | 开箱抽一张卡 |
| 按 `G` 或点「Gold Chest」按钮 | 买一个黄金宝箱（声望解锁后，保底 rare+） |
| 按 `P` 或点「Prestige」按钮 | 转生：清空本轮，累计声望解锁新卡池 |
| 等待 | 持有的卡牌每秒自动产金币 |

- 初始 20 金币，正好买两个宝箱。
- 基础 5 档稀有度（Common → Legendary），权重掉落，稀有度越高产币越多。
- 抽到重复卡累计副本数，按 1/2/4/8/16 阈值升级，收入随等级 ×1.5。
- 已满级卡再抽到重复，转为按稀有度折算的金币（基础收入 ×3）。
- 宝箱价格随累计产出线性上涨（每 1000 累计收入 +1），无封顶，最终倒逼转生。
- 转生累计声望解锁 Mythic（3）/ 黄金宝箱（5）/ Ancient（10）/ Astral（20）新内容，新稀有度混入所有宝箱。经济设计详见 [DESIGN.md](./DESIGN.md)。

## 技术说明

- 引擎：three.js r185，基于 `@a3game/playable` 运行时框架（A3GameFactory）。
- 架构遵循「UI → Mechanic → 框架」依赖方向，纯逻辑模块（`catalog` / `economy` / `game`）不依赖 three.js，可 headless 测试。
- 交付形式：偏 2D UI（DOM HUD 叠加）+ 一个程序化 3D 展台（宝箱 + 卡牌墙），无需任何外部 `.glb` 模型。

## 目录结构

```
gameE_card_collector/
├── src/main.js                  # 宿主入口：导入 gameplay 包并启动
├── mechanic_contract.json       # 公共 Mechanic 契约（state / events / commands）
├── context_used.json            # 使用的上下文记录
├── DESIGN.md                    # 经济设计：成本曲线与转生方案
└── packages/card-collector/     # 生成的 gameplay 包
    ├── package.json
    ├── src/
    │   ├── catalog.js           # 卡牌目录、稀有度权重、收入公式、种子随机
    │   ├── economy.js           # 金币、宝箱商店、被动收入计时
    │   ├── game.js              # 规则编排：买 / 开 / 产币 + 订阅式状态
    │   ├── renderer.js          # 3D 展台（宝箱弹跳 + 卡牌墙）
    │   └── index.js             # 启动、HUD、按键 / 按钮输入
    └── tests/
        └── card-collector.spec.js   # 35 个 vitest 用例覆盖核心循环
```

## 运行

本目录为**源码快照**，不含框架与依赖。要运行请使用完整项目：

```bash
cd test_data/outputs/gameE_card_collector/default/mechanic/card_collector_001
npm run dev   # 打开 http://127.0.0.1:5173/
```

## 验证证据

- 55 个测试通过（35 个游戏逻辑 + 20 个框架方向契约）。
- `vite build` 成功。
- 无头浏览器 playtest 录像跑通完整循环（买箱 → 开箱抽卡 → 产币），证据见完整项目下的 `.a3game/playtest/`。
