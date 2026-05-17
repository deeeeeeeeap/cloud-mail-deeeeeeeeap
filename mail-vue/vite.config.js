import {defineConfig, loadEnv} from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import {ElementPlusResolver} from 'unplugin-vue-components/resolvers'
import {VitePWA} from 'vite-plugin-pwa';

export default defineConfig(({mode}) => {
    const env = loadEnv(mode, process.cwd(), 'VITE')
    return {
        server: {
            host: true,
            port: 3001,
            hmr: true,
        },
        base: env.VITE_STATIC_URL || '/',
        plugins: [vue(),
            VitePWA({
                injectRegister: 'script-defer',
                manifest: {
                    name: env.VITE_PWA_NAME,
                    short_name: env.VITE_PWA_NAME,
                    background_color: '#FFFFFF',
                    theme_color: '#FFFFFF',
                    icons: [
                        {
                            src: 'mail-pwa.png',
                            sizes: '192x192',
                            type: 'image/png',
                        }
                    ],
                },
                workbox: {
                    disableDevLogs: true,
                    globPatterns: [],
                    runtimeCaching: [],
                    navigateFallback: null,
                    cleanupOutdatedCaches: true,
                }
            }),
            AutoImport({
                resolvers: [ElementPlusResolver()],
            }),
            Components({
                resolvers: [ElementPlusResolver()],
            })
        ],
        resolve: {
            alias: {
                '@': path.resolve(__dirname, 'src')
            }
        },
        build: {
            target: 'es2022',
            outDir: env.VITE_OUT_DIR || 'dist',
            emptyOutDir: true,
            assetsInclude: ['**/*.json'],
            rollupOptions: {
                output: {
                    manualChunks(id) {
                        if (!id.includes('node_modules')) return;
                        if (id.includes('element-plus/es/components/')) {
                            const component = id.split('element-plus/es/components/')[1]?.split('/')[0];
                            return component ? `element-plus-${component}` : 'element-plus-components';
                        }
                        if (id.includes('@element-plus/icons-vue')) return 'element-plus-icons';
                        if (id.includes('element-plus')) return 'element-plus-core';
                        if (id.includes('echarts')) return 'echarts';
                        if (id.includes('dexie')) return 'dexie';
                        if (id.includes('@iconify')) return 'iconify';
                        if (id.includes('@vueuse')) return 'vueuse';
                        if (id.includes('vue-router')) return 'vue-router';
                        if (id.includes('vue-i18n')) return 'vue-i18n';
                        if (id.includes('pinia')) return 'pinia';
                        if (id.includes('vue')) return 'vue-core';
                        if (id.includes('lodash')) return 'lodash';
                        return 'vendor';
                    }
                }
            }
        }
    }
})
