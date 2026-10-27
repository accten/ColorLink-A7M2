# 界面设计说明

## 1. 参考的开源项目（以及各自被借鉴的部分）

| 项目 | 许可 | 借鉴点 |
|---|---|---|
| [obytes/react-native-template-obytes](https://github.com/obytes/react-native-template-obytes) | MIT | 令牌驱动的布局：间距/圆角/字阶集中定义；页面骨架 = 顶部小标签 + 大字标题 + 卡片分区；不堆装饰，靠留白和层级 |
| [Shopify/react-native-skia](https://github.com/Shopify/react-native-skia) | MIT | "画布即视图"：取景与调色共用同一块 GPU 画布；runtime shader + ImageShader 的组合方式；`makeImageSnapshot().encodeToBytes()` 出图 |
| [expo/examples](https://github.com/expo/examples) | MIT | Expo Router 的目录/路由约定、Dev Client 构建流程 |

没有直接依赖 Tamagui / NativeWind 这类 UI 框架：这个 App 只有 4 个页面、1 套视觉，
引入组件库反而要多维护一层主题映射。设计令牌 + 12 个手写原语（`src/design/ui.tsx`）足够，
而且体积为零、可控性最高。

## 2. 视觉基调

- **近黑底 + 暖白字**：`#08090A` / `#F4F2EE`。不用纯白 `#FFF`，避免 OLED 上刺眼。
- **单一点缀色**：象牙白 `#E8DFCF` 只用于主按钮、当前状态、滑块填充；暖橙 `#E3B27C` 只出现在图标里。
- **1px hairline 分隔**：`rgba(255,255,255,0.075)`，比常见的 `#222` 更"薄"，是"高级感"的关键之一。
- **字距**：大标题收紧（-1.1px），小标签放大（+1.5px、全大写、10.5px）。两者形成对比，页面立刻不"平"。
- **等宽数字**：所有文件名、尺寸、哈希、耗时都用 mono + `tabular-nums`，避免数字跳动。
- **无阴影的层级**：卡片靠底色差（`#111316`）+ 描边分层；只有浮层（Sheet / Toast）用阴影。

## 3. 令牌

```
颜色  bg #08090A · bgElev #0C0E10 · surface #111316 · surfaceHi #171A1E
      hairline 7.5% 白 · text #F4F2EE · textMuted #9AA0A6 · textFaint #646A70
      accent #E8DFCF · ok #7FD1A6 · warn #E0C07B · danger #E0868A
间距  2 / 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48
圆角  4 / 8 / 12 / 16 / 22 / pill
字阶  display 34 · title 21 · section 16 · body 15 · bodyMuted 14 · label 10.5(大写) · mono 12
触控  最小 44pt
```

定义在 `src/design/tokens.ts`，禁止页面里写魔法数字。

## 4. 页面

| 页面 | 文件 | 设计要点 |
|---|---|---|
| 相机 / 连接 | `app/(tabs)/index.tsx` | 大标题 + 状态卡（状态点 + 模式 Pill + 电量/存储/帧率三列统计）；主行动按钮只有一个；M0 未接入原生层时给一条明确的信息条，而不是假装可用 |
| 取景 | `app/live.tsx` | 画面占满、控制层贴边、只有快门是实心圆；顶部 LIVE/FPS/电量用 mono 小字；轻点画面 1.8× 放大；三分线可切换 |
| 图库 | `app/(tabs)/gallery.tsx` | 3 列方格、1.5px 间隙、方图裁切；有调色的照片右下角点一个象牙小点；长按删除走系统确认 |
| 编辑器 | `app/editor/[id].tsx` | 上：等比画布（按原图比例，不做 letterbox 拉伸）+ "按住对比"；下：三段面板（调色 / 预设 / AI），滑块使用自绘 2px 轨道 + 14px 圆点 |
| 设置 | `app/(tabs)/settings.tsx` | 分组卡片：AI Key（掩码展示）、导出尺寸/质量、相机与诊断；所有破坏性操作都要二次确认 |

## 5. 动效

- 只做三类：页面切换（fade / slide，180–260ms）、Sheet 上滑、按下态（透明度 0.55–0.85）。
- 快门有单独的回弹动画（scale 0.9 → 1）。
- 滑块拖动**不加**动画：参数是连续的，任何补间都会让人觉得"跟不上手"。

## 6. 可访问性

- 所有图标按钮带 `accessibilityLabel`；分段控件带 `accessibilityState.selected`。
- 触控区域统一 ≥44pt（`IconButton` 36pt + `hitSlop` 补足）。
- 正文最小 12px，且不使用低于 4.5:1 对比度的灰（`textFaint` 只用于非关键信息）。

## 7. 已知的取舍

1. 深色是唯一主题（相机/调色场景下更合适，也省掉双主题验证成本）。
2. 没有做「拖拽排序 / 多选批量」——图库规模在 MVP 阶段是几百张，先保证单张路径顺滑。
3. 编辑器未做双指缩放（P1），当前用"按住对比 + 预设切换"覆盖主要判断动作。
