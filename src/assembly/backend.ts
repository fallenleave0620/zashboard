import { displayAllFeatures } from '@/store/settings'
import { activeBackend } from '@/store/setup'
import { computed, ref } from 'vue'
import { daeCapabilities } from './capabilities'

export enum Core {
  Mihomo = 'mihomo',
  Honk = 'honk',
  // sing-box 走 Clash 兼容 API 时也属于「Clash 通道上的非 mihomo 内核」
  Singbox = 'singbox',
  Dae = 'dae',
  Unknown = 'unknown',
}

export const core = ref<Core>(Core.Unknown)

export const resetCore = () => {
  core.value = Core.Unknown
}

const isNonMihomoCore = computed(
  () =>
    (core.value === Core.Honk || core.value === Core.Singbox) &&
    activeBackend.value?.type !== 'dae',
)

const isForkCoreOverride = computed(() => isNonMihomoCore.value && displayAllFeatures.value)

export const showDisplayAllFeatures = computed(() => !!activeBackend.value && isNonMihomoCore.value)

export type Cap =
  | 'coreUpgrade'
  | 'coreRestart'
  | 'dashboardUpgrade'
  | 'reloadConfigs'
  | 'updateConfigs'
  | 'updateGeoDatabase'
  | 'syncSettings'
  | 'independentLatency'
  | 'coreUpdateCheck'
  | 'configPatch'
  | 'modeSwitch'
  | 'traceLogLevel'
  | 'extraLogLevels'
  | 'memoryStats'
  | 'silentLogLevel'
  | 'runtimeStats'
  | 'latencyTest'
  | 'proxyProviderUpdate'
  | 'proxyProviderHealthCheck'
  | 'ruleProviders'
  | 'flushDNSCache'
  | 'flushFakeIP'
  | 'dnsQuery'
  | 'connectionsClose'
  | 'connectionsFilterClose'
  | 'customTestUrl'
  | 'nodeLatencyTest'
  | 'metricsHistory'
  | 'backendEvents'
  | 'flows'
  | 'dnsCache'
  | 'dnsLog'
  | 'dnsRules'
  | 'routingTrace'
  | 'datapath'
  | 'runtimeSettings'
  | 'geodataSettings'
  | 'configSources'
  | 'configCreate'
  | 'configEdit'
  | 'entryManage'
  | 'groupConfigPatch'
  | 'lifecycleControl'

type Caps = Partial<Record<Cap, boolean>>

const clashCaps = computed<Caps>(() => {
  const mihomo = core.value === Core.Mihomo
  const honk = core.value === Core.Honk
  const singbox = core.value === Core.Singbox
  const mihomoOrForkCore = mihomo || isForkCoreOverride.value

  return {
    coreUpgrade: mihomoOrForkCore,
    coreRestart: mihomoOrForkCore,
    dashboardUpgrade: mihomoOrForkCore,
    reloadConfigs: mihomoOrForkCore,
    updateConfigs: mihomoOrForkCore,
    updateGeoDatabase: mihomoOrForkCore,
    syncSettings: mihomoOrForkCore,
    independentLatency: mihomoOrForkCore,
    coreUpdateCheck: mihomo,
    configPatch: mihomo,
    // sing-box 的 Clash 兼容 API 支持 PATCH /configs 切模式（clash_mode），
    // 但没有端口 / TUN 这些 mihomo 配置块，所以单独一个开关。
    modeSwitch: mihomoOrForkCore || singbox,

    // trace 与 fatal / panic 级别：sing-box 有，mihomo 没有。
    traceLogLevel: honk || singbox,
    extraLogLevels: singbox,
    silentLogLevel: mihomo,

    // 内存占用：mihomo/honk 走 Clash WS /memory；sing-box 用 GET /memory 轮询。
    memoryStats: mihomo || honk || singbox || isForkCoreOverride.value,

    runtimeStats: honk,

    latencyTest: true,
    proxyProviderUpdate: true,
    proxyProviderHealthCheck: true,
    ruleProviders: true,
    flushDNSCache: true,
    flushFakeIP: true,
    dnsQuery: true,
    connectionsClose: true,
    customTestUrl: true,
    nodeLatencyTest: true,
  }
})

const daeCaps = computed<Caps>(() => {
  const resources = daeCapabilities.value?.resources
  const settingFields = resources?.runtime_settings?.fields ?? []

  return {
    reloadConfigs: resources?.reload?.available === true,
    updateGeoDatabase: resources?.geodata?.can_update === true,

    traceLogLevel: resources?.logs?.levels?.includes('trace') === true,

    runtimeStats: resources?.runtime_outbounds?.available === true,

    modeSwitch: false,
    memoryStats: true,

    latencyTest: resources?.probes?.available === true,
    proxyProviderUpdate: resources?.providers?.can_refresh === true,
    flushDNSCache: resources?.dns_cache?.flush === true,
    dnsQuery: resources?.dns_query?.available === true,
    connectionsClose: resources?.connections?.can_close === true,
    connectionsFilterClose: resources?.connections?.can_close === true,
    metricsHistory:
      resources?.traffic_history?.available === true ||
      resources?.memory_history?.available === true,
    backendEvents: resources?.events?.available === true,
    flows: resources?.flows?.available === true,
    dnsCache: resources?.dns_cache?.read === true,
    dnsLog: resources?.dns_log?.available === true,
    dnsRules: resources?.dns_rules?.available === true,
    routingTrace: resources?.routing_trace?.available === true,
    datapath: resources?.datapath?.available === true,
    runtimeSettings: resources?.runtime_settings?.available === true,
    geodataSettings:
      resources?.geodata?.configurable_sources === true && settingFields.includes('geodata'),
    configSources: resources?.config?.available === true,
    configEdit: resources?.config?.writable === true,
    configCreate: resources?.config?.writable === true && resources?.config?.create === true,
    entryManage: resources?.nodes?.can_manage === true || resources?.providers?.can_manage === true,
    groupConfigPatch: resources?.groups?.config_patch === true,
    lifecycleControl:
      resources?.suspend?.available === true && resources?.resume?.available === true,
  }
})

const soft = computed<Caps>(() =>
  activeBackend.value?.type === 'dae' ? daeCaps.value : clashCaps.value,
)

export const can = (cap: Cap): boolean => {
  if (!activeBackend.value) return false

  return soft.value[cap] === true
}
