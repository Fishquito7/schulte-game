# 舒尔特方格 · 形状挑战

一个单文件、零依赖的舒尔特方格（Schulte Grid）小游戏。点击 1→N 按顺序找数字，三种棋盘形状、实时评分、圆环模式下每一圈会独立转动。

在线试玩：**https://fishquito.github.io/schulte-game/**

![方形](assets/preview-square.png)

## 玩法

- 从数字 **1** 开始，按顺序点击，直到点完最后一个数字。
- 点错一次 **+1 秒罚时**，并计入失误次数。
- 3-2-1 倒计时结束后计时开始，点完最后一格停表。
- 成绩按「形状 × 尺寸 × 正序/倒序」分别记录最佳（`localStorage`）。

## 三种棋盘

| 模式 | 说明 |
|---|---|
| **方形** | 标准舒尔特方格，行列有对齐线索，最省力 |
| **圆环** | 同心环 + 扇区。半径按 `r_k = R·√(累计格数/总格数)` 分布，保证每格面积相等；每一圈以不同角速度、不同方向缓慢自转，数字始终保持竖直 |
| **星芒** | 五角星轮廓 + Voronoi 碎块。先在单位圆里生成 Voronoi（圆是凸的，半平面裁剪才成立），再按角度把半径映射到星形边界；连续映射保证格子不会被切断。轮廓带凹角，视线没法一次扫完，难度最高 |

圆环的每一圈转速：`[中心 0°, 内环 +6°/s, 中环 −4.2°/s, 外环 +3.1°/s]`。右下角「动效」开关可关闭转动——关闭后成绩与静态模式可比。

## 排行榜

点右上角 🏆 打开。按「形状 × 尺寸 × 正序/倒序」共 18 个榜单，每项保留前 **20** 名，按用时升序。

**本机榜**：存在 `localStorage`（键 `schulte.lb.v1`），离线可用，换设备/清缓存即消失。

**全球榜（可选）**：接一个 Supabase 免费库即可，不需要写任何服务端代码。

1. 在 [supabase.com](https://supabase.com) 建一个项目（免费额度足够）；
2. 打开 SQL Editor，把 [`supabase.sql`](supabase.sql) 整段粘贴执行 —— 建表 + 索引 + RLS；
3. 到 Project Settings → API 复制 **Project URL** 和 **anon public key**，填进 `index.html` 顶部的 `NET`：

```js
const NET = Object.assign({
  url: 'https://xxxxxxxx.supabase.co',   // ← 你的 Project URL
  key: 'eyJhbGciOi...',                  // ← anon public key
  table: 'scores'
}, window.SCHULTE_NET || {});
```

留空则自动退回纯本机模式，界面上不会出现「全球」页签。

**为什么 anon key 可以公开**：它本来就随前端下发。真正的安全边界是 RLS —— `supabase.sql` 里只开放了 `select` 和 `insert`，没有 `update / delete` 策略，所以匿名用户改不了、删不掉任何一条成绩；插入时还有 `check` 约束挡住越界数值。

**署名**：结算面板填一次名字（存在 `localStorage`，最多 12 字），本机榜立即显示，点「上榜」提交到全球榜。名字只用于展示，不做身份校验。

![排行榜](assets/preview-leaderboard.png)

![全球榜](assets/preview-global.png)

## 星芒模式

![星芒](assets/preview-star.png)

## 评分

```
评分 = 基准时间 ÷ 用时 × 100     （上限 120）
```

| 等级 | 条件 |
|---|---|
| S | ≥ 100（达到或快于基准） |
| A | ≥ 85 |
| B | ≥ 70 |
| C | ≥ 55 |
| D | < 55 |

S 级基准时间（秒）：

| | 4×4 | 5×5 | 6×6 |
|---|---|---|---|
| 方形 | 18 | 30 | 48 |
| 圆环 | 22 | 38 | 58 |
| 星芒 | 21 | 35 | 54 |

圆环基准高于方形约 27%，因为转动本身提高了搜索代价；星芒没有对齐线索、轮廓还有凹角，也比方形高约 17%。三种模式的成绩不能直接比时间。

## 运行

直接双击 `index.html`，或：

```bash
# 任选其一
python -m http.server 8000
npx serve .
```

## 许可

MIT
