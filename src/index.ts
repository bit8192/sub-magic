import { initConfigIfEmpty } from './config'
import { handleRequest } from './api'

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url)

		ctx.waitUntil(initConfigIfEmpty(env))

		if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/sub/')) {
			return handleRequest(request, env)
		}

		return (env as any).ASSETS.fetch(request)
	},
} satisfies ExportedHandler<Env>
