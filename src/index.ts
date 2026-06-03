import { initConfigIfEmpty } from './config'
import { handleRequest } from './api'
import { getConfigSyncDO } from './durable-objects/config-sync'
import { requireAuth, requireAccessKey } from './auth'

// 导出 Durable Object 类，供 Wrangler 注册
export { ConfigSync } from './durable-objects/config-sync'

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url)

		ctx.waitUntil(initConfigIfEmpty(env))

		// WebSocket 实时同步端点（需要认证）
		if (url.pathname === '/api/sync' && request.headers.get('Upgrade') === 'websocket') {
			const authErr = await requireAuth(request, env)
			if (!authErr) {
				const doStub = getConfigSyncDO(env)
				return doStub.fetch(request)
			}
			const accessErr = await requireAccessKey(request, env)
			if (!accessErr) {
				const doStub = getConfigSyncDO(env)
				return doStub.fetch(request)
			}
			return authErr
		}

		if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/sub/')) {
			return handleRequest(request, env)
		}

		return (env as any).ASSETS.fetch(request)
	},
} satisfies ExportedHandler<Env>
