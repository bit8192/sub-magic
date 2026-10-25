import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		// geoip/geosite 的两个脚本是单独用 node 跑的取样工具（会下载 dat、process.exit），不适合放进 workers 池
		exclude: [
			'**/node_modules/**',
			'**/dist/**',
			'test/geoip-parser.test.js',
			'test/geosite-parser.test.js',
		],
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					kvNamespaces: ['SUB_MAGIC'],
				},
			},
		},
	},
});
