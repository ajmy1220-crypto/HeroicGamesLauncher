/**
 * backendCapabilities.ts
 * ------------------------------------------------------------------
 * 後端能力邊界表（藍圖 §5）——決策層的第一級依據。
 *
 * 設計原則：
 *   - 純資料驅動：能力隨上游演進時，只改下方 CAPABILITIES 常數，
 *     不動查表邏輯（§5 明示「獨立成設定檔方便更新，不要散落在邏輯中」）。
 *   - 純查表函式：supports / candidatesFor / pickBackend 無副作用、無 IO、無 AI。
 *
 * 決策三軸 = DirectX 版本 × 晶片(arch) × 反作弊（反作弊在 engine 處理）。
 * 本表只負責「DX 版本 × arch → 哪些後端合法、偏好序如何」。
 *
 * preferenceRank：數字越小越優先（pickBackend / candidatesFor 升冪挑選）。
 *   dxmt(1) < dxvk(2) < gptk(3) < crossover(4) < wined3d(5)
 * 此序確保：
 *   - ARM 上 DX10/11 首選 dxmt（rank 1），dxvk 次之（rank 2）——對齊 §5。
 *   - gptk 雖誠實宣告支援 DX11（§2.2「DX11/12」），但 rank 3 低於 dxvk/dxmt，
 *     故 candidatesFor(11,'arm64') 永遠先給 dxmt/dxvk，DX11 不會誤推 gptk。
 *   - crossover（商業付費）rank 4，由 engine 預設放入 exclude，不作自動建議。
 *   - wined3d（無翻譯層、最慢保底）rank 5，僅最後手段。
 */

import type { Arch, Backend, DirectXVersion } from './types';

/** 單一後端的能力宣告。型別就近放此檔（只有 engine 消費），不污染 types.ts。 */
export interface BackendCapability {
  backend: Backend;
  /** 支援的 DirectX 主版本清單。 */
  directx: DirectXVersion[];
  /** 支援的晶片架構清單。 */
  arch: Arch[];
  /** 是否僅 Apple Silicon（資訊冗餘於 arch，但便於人讀與快速斷言）。 */
  appleSiliconOnly: boolean;
  /** 偏好序，數字越小越優先。 */
  preferenceRank: number;
  notes?: string;
}

/**
 * 能力表（§5 逐格對齊）。
 *
 * 校準標註：
 *   [VERIFIED] = 與 §2.2/§5 文件一致、屬已知穩定事實。
 *   [SEED]     = 待 Bryan 真機校準的細項（標於 notes 內）。
 */
export const CAPABILITIES: BackendCapability[] = [
  {
    backend: 'dxmt',
    directx: [10, 11],
    arch: ['arm64'],
    appleSiliconOnly: true,
    preferenceRank: 1,
    notes:
      '[VERIFIED §5] DXMT（DX→Metal），DX10/11，僅 Apple Silicon，經 Wine-Staging 變體安裝。' +
      '不支援 D3D9、不支援 DX12。ARM 上 DX10/11 首選（rank 最高=1）。' +
      '[SEED] 32-bit DX11 技術上可但 WoW64 摩擦大（§5 最糟組合），信心需真機校準。',
  },
  {
    backend: 'dxvk',
    directx: [9, 10, 11],
    arch: ['arm64', 'x86_64'],
    appleSiliconOnly: false,
    preferenceRank: 2,
    notes:
      '[VERIFIED §5] DXVK-macOS（Gcenx fork，DX→Vulkan via MoltenVK）。' +
      '唯一支援 D3D9 的翻譯後端（DXMT 不做 D3D9）。Intel+ARM 皆可。' +
      'DX9 唯一翻譯解、Intel Mac 上 DX10/11 首選。不支援 DX12。' +
      '在 ARM 上 DX10/11 偏好序低於 dxmt（rank 2 vs 1）。',
  },
  {
    backend: 'gptk',
    directx: [11, 12],
    arch: ['arm64'],
    appleSiliconOnly: true,
    preferenceRank: 3,
    notes:
      '[VERIFIED §2.2/§5] GPTK（Apple Game Porting Toolkit，D3DMetal），僅 Apple Silicon。' +
      'DX12 的唯一可用後端（dxmt/dxvk 不支援 DX12）。能力宣告含 DX11 以誠實反映 ' +
      '§2.2『DX11/12』，但因 rank 3 低於 dxvk(2)/dxmt(1)，candidatesFor(11,arm64) ' +
      '永遠先給 dxmt/dxvk，故 DX11 不會誤推 gptk（對齊 §5 路由 DX11→DXMT/DXVK）。' +
      '[SEED] gptk 對純 DX11 的真機效果待 Bryan 校準。',
  },
  {
    backend: 'crossover',
    directx: [9, 10, 11, 12],
    arch: ['arm64', 'x86_64'],
    appleSiliconOnly: false,
    preferenceRank: 4,
    notes:
      '[VERIFIED §2.2/§5] 商業方案，最強，Intel+ARM，涵蓋 DX9~12。' +
      '是 Intel Mac 跑 DX12 的唯一選項（gptk 不支援 Intel）。' +
      '因需付費授權，engine 預設將其放入 exclude，僅在無免費後端可用時以 ' +
      'kind:\'none\' 提示出現（autoApplyable 恆 false），不作自動套用的 switch_backend。' +
      'rank 4（高於 wined3d、低於免費翻譯後端）。',
  },
  {
    backend: 'wined3d',
    directx: [9, 10, 11],
    arch: ['arm64', 'x86_64'],
    appleSiliconOnly: false,
    preferenceRank: 5,
    notes:
      '[VERIFIED §2.2] 無翻譯層、最慢的保底 fallback（DX→OpenGL）。Intel+ARM 皆可，' +
      '不支援 DX12。preferenceRank 最低，pickBackend 預設不選為主動建議——' +
      '只在所有翻譯後端皆排除時的最後手段。納入能力表僅為完整性與 currentBackend 比對。',
  },
];

// ── 查表輔助函式（純函式）─────────────────────────────────────────

/** 內部：以 backend 取得能力宣告（找不到回 undefined）。 */
function capOf(backend: Backend): BackendCapability | undefined {
  return CAPABILITIES.find((c) => c.backend === backend);
}

/**
 * 某後端是否在指定 DX 版本 + arch 下合法。
 * backend 未知、或 dx / arch 不在其支援清單 → false。
 */
export function supports(backend: Backend, dx: DirectXVersion, arch: Arch): boolean {
  const cap = capOf(backend);
  if (!cap) return false;
  return cap.directx.includes(dx) && cap.arch.includes(arch);
}

/**
 * 給 DX 版本 + arch，回傳所有合法後端，依 preferenceRank 升冪（最優先在前）。
 * 不做 exclude（純列舉）；排除交給 pickBackend / 呼叫端。
 */
export function candidatesFor(dx: DirectXVersion, arch: Arch): Backend[] {
  return CAPABILITIES.filter((c) => c.directx.includes(dx) && c.arch.includes(arch))
    .slice()
    .sort((a, b) => a.preferenceRank - b.preferenceRank)
    .map((c) => c.backend);
}

/**
 * 給 arch + DX 版本，挑出偏好序最高（rank 最小）的合法後端。
 * exclude 內的後端會被跳過（engine 通常傳 [currentBackend, 商業未授權的 crossover]）。
 * 無合法後端 → undefined。
 */
export function pickBackend(
  arch: Arch,
  dx: DirectXVersion,
  exclude: Backend[] = [],
): Backend | undefined {
  const blocked = new Set(exclude);
  for (const backend of candidatesFor(dx, arch)) {
    if (!blocked.has(backend)) return backend;
  }
  return undefined;
}
