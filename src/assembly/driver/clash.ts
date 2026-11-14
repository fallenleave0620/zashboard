import {
  blockConnectionByIdAPI,
  createClashWebSocket,
  deleteFixedProxyAPI,
  deleteStorageAPI,
  disconnectAllClashAPI,
  disconnectClashByIdAPI,
  fetchClashMemoryAPI,
  fetchClashVersion,
  fetchHonkStatsAPI,
  fetchProxiesAPI,
  fetchProxyGroupLatencyAPI,
  fetchProxyLatencyAPI,
  fetchProxyProviderAPI,
  fetchProxyProviderLatencyAPI,
  fetchRuleProvidersAPI,
  fetchRulesAPI,
  fetchSmartWeightsAPI,
  flushDNSCacheAPI,
  flushFakeIPAPI,
  flushSmartGroupWeightsAPI,
  getConfigsAPI,
  getStorageAPI,
  patchConfigsAPI,
  probeClashChannel,
  proxyProviderHealthCheckAPI,
  queryDNSAPI,
  reloadConfigsAPI,
  restartCoreAPI,
  selectProxyAPI,
  setStorageAPI,
  toggleRuleDisabledAPI,
  toggleRuleDisabledRefindAPI,
  updateConfigsAPI,
  updateGeoDataAPI,
  updateProxyProviderAPI,
  updateRuleProviderAPI,
  upgradeCoreAPI,
  upgradeUIAPI,
} from '@/api/clash'
import { core, Core } from '@/assembly/backend'
import { proxyMap } from '@/assembly/proxies/state'
import { PROXY_TYPE } from '@/constant'
import type { ClashConnectionRawMessage, Connection, Log } from '@/types'
import { head } from 'lodash'
import { shallowRef, watch } from 'vue'
import type {
  ConnectionAccessor,
  ConnectionsPayload,
  Driver,
  MemorySample,
  Stream,
  TrafficSample,
} from './types'

const done = (request: Promise<unknown>): Promise<void> => request.then(() => undefined)

const POLL_INTERVAL = 1000

/** 轮询型 Stream（sing-box 的 /memory 只有一次性 GET，没有 WS 流）。 */
const poll = <T>(request: () => Promise<T>, interval = POLL_INTERVAL): Stream<T> => {
  const data = shallowRef<T>()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const tick = async () => {
    try {
      const next = await request()
      if (!stopped) data.value = next
    } catch {}
    if (!stopped) timer = setTimeout(tick, interval)
  }

  tick()

  return {
    data,
    close: () => {
      stopped = true
      clearTimeout(timer)
    },
  }
}

const asClash = (connection: Connection) => connection as ClashConnectionRawMessage

const getNetwork = (c: ClashConnectionRawMessage) => {
  const { destinationPort, sniffHost, network } = c.metadata

  if ((destinationPort === '443' || sniffHost) && network === 'udp') {
    return 'quic'
  }

  return network
}

const getHostname = (c: ClashConnectionRawMessage) =>
  c.metadata.host || c.metadata.sniffHost || c.metadata.destinationIP

const getFinalProxyType = (c: ClashConnectionRawMessage) =>
  proxyMap.value[head(c.chains) || '']?.type.toLowerCase()

const accessor: ConnectionAccessor = {
  chains: (connection) => asClash(connection).chains,
  download: (connection) => asClash(connection).download,
  upload: (connection) => asClash(connection).upload,
  start: (connection) => asClash(connection).start,
  rule: (connection) => {
    const clash = asClash(connection)

    return clash.rulePayload ? `${clash.rule}: ${clash.rulePayload}` : clash.rule
  },
  rulePayload: (connection) => asClash(connection).rulePayload,
  sourceIP: (connection) => asClash(connection).metadata.sourceIP,
  sourcePort: (connection) => asClash(connection).metadata.sourcePort,
  network: (connection) => getNetwork(asClash(connection)),
  networkType: (connection) => {
    const clash = asClash(connection)

    return `${clash.metadata.type} | ${getNetwork(clash)}`
  },
  hostname: (connection) => getHostname(asClash(connection)),
  host: (connection) => {
    const clash = asClash(connection)
    const host = getHostname(clash)

    if (host.includes(':')) {
      return `[${host}]:${clash.metadata.destinationPort}`
    }
    return `${host}:${clash.metadata.destinationPort}`
  },
  process: (connection) => {
    const { metadata } = asClash(connection)

    return metadata.process || metadata.processPath?.replace(/^.*[/\\](.*)$/, '$1') || '-'
  },
  destination: (connection) => {
    const clash = asClash(connection)

    if (getFinalProxyType(clash) === PROXY_TYPE.Direct && clash.metadata.remoteDestination) {
      return clash.metadata.remoteDestination
    }

    return clash.metadata.destinationIP || clash.metadata.host
  },
  inboundUser: (connection) => {
    const { metadata } = asClash(connection)

    return metadata.inboundUser || metadata.inboundName || metadata.inboundPort || '-'
  },
  sniffHost: (connection) => asClash(connection).metadata.sniffHost,
  remoteAddress: (connection) => asClash(connection).metadata.remoteDestination,
  isDirect: (connection) => getFinalProxyType(asClash(connection)) === PROXY_TYPE.Direct,
  smartBlock: (connection) => asClash(connection).metadata.smartBlock,
}

const subscribeConnections = (): Stream<ConnectionsPayload> => {
  const ws = createClashWebSocket<{
    connections: ClashConnectionRawMessage[]
    downloadTotal: number
    uploadTotal: number
  }>('connections')
  const data = shallowRef<ConnectionsPayload>()

  const unwatch = watch(ws.data, (raw) => {
    if (!raw) return

    data.value = {
      connections: raw.connections ?? [],
      downloadTotal: raw.downloadTotal,
      uploadTotal: raw.uploadTotal,
    }
  })

  return {
    data,
    close: () => {
      unwatch()
      ws.close()
    },
  }
}

export const clashDriver: Driver = {
  type: 'clash',

  system: {
    probe: (backend, timeout, signal) => probeClashChannel(backend, timeout, signal),
    fetchVersion: async () => (await fetchClashVersion()).data?.version || '',
    upgradeCore: (channel) => done(upgradeCoreAPI(channel)),
    restartCore: () => done(restartCoreAPI()),
    upgradeUI: () => done(upgradeUIAPI()),
    getStorage: async () => (await getStorageAPI()).data,
    setStorage: (value) => done(setStorageAPI(value)),
    deleteStorage: () => done(deleteStorageAPI()),
  },

  metrics: {
    traffic: () => createClashWebSocket<TrafficSample>('traffic'),
    memory: () => {
      // sing-box 的 Clash 兼容 API 只有 GET /memory 快照，没有 /memory 的 WS 流
      if (core.value === Core.Singbox) {
        return poll(async () => (await fetchClashMemoryAPI()).data)
      }

      return createClashWebSocket<MemorySample>('memory')
    },
    fetchRuntimeStats: async () => (await fetchHonkStatsAPI()).data,
  },

  proxies: {
    fetch: async () => {
      const [proxyRes, providerRes] = await Promise.all([
        fetchProxiesAPI(),
        fetchProxyProviderAPI(),
      ])

      return {
        proxies: proxyRes.data.proxies,
        providers: Object.values(providerRes.data.providers).filter(
          (provider) => provider.name !== 'default' && provider.vehicleType !== 'Compatible',
        ),
      }
    },
    select: (group, name) => done(selectProxyAPI(group, name)),
    clearFixed: (group) => done(deleteFixedProxyAPI(group)),
    testNode: async (name, url, timeout) =>
      (await fetchProxyLatencyAPI(name, url, timeout)).data.delay,
    testProviderNode: async (provider, name, url, timeout) =>
      (await fetchProxyProviderLatencyAPI(provider, name, url, timeout)).data.delay,
    testGroup: async (group, url, timeout) =>
      (await fetchProxyGroupLatencyAPI(group, url, timeout)).data,
    updateProvider: (name) => done(updateProxyProviderAPI(name)),
    healthCheckProvider: (name) => done(proxyProviderHealthCheckAPI(name)),
    fetchSmartWeights: async () => (await fetchSmartWeightsAPI()).data.weights,
    flushSmartWeights: () => done(flushSmartGroupWeightsAPI()),
  },

  rules: {
    fetch: async () => {
      const [ruleRes, providerRes] = await Promise.all([fetchRulesAPI(), fetchRuleProvidersAPI()])

      return {
        rules: ruleRes.data.rules.map((rule) => {
          const proxy = rule.proxy

          return {
            ...rule,
            proxy: proxy.startsWith('route(') ? proxy.slice(6, -1) : proxy,
          }
        }),
        providers: Object.values(providerRes.data.providers),
      }
    },
    updateProvider: (name) => done(updateRuleProviderAPI(name)),
    toggleDisabled: async (rule, disabled) => {
      if (rule.uuid) {
        await toggleRuleDisabledRefindAPI(rule.uuid)
        return
      }

      await toggleRuleDisabledAPI({ [rule.index]: disabled })
    },
  },

  config: {
    fetch: async () => (await getConfigsAPI()).data,
    patch: (config) => done(patchConfigsAPI(config)),
    reload: () => done(reloadConfigsAPI()),
    load: (config, force) => done(updateConfigsAPI(config, force)),
    updateGeoData: () => done(updateGeoDataAPI()),
    flushFakeIP: () => done(flushFakeIPAPI()),
    flushDNSCache: () => done(flushDNSCacheAPI()),
    queryDNS: async (params) => (await queryDNSAPI(params)).data,
  },

  logs: {
    subscribe: (level, onBatch) => {
      const ws = createClashWebSocket<Log>('logs', { level })
      const unwatch = watch(ws.data, (data) => {
        if (data) onBatch([data])
      })

      return {
        close: () => {
          unwatch()
          ws.close()
        },
      }
    },
  },

  connections: {
    accessor,
    subscribe: subscribeConnections,
    disconnect: (id) => done(disconnectClashByIdAPI(id)),
    disconnectAll: () => done(disconnectAllClashAPI()),
    block: (id) => done(blockConnectionByIdAPI(id)),
  },
}
