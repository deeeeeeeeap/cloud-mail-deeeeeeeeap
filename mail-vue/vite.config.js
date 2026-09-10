import {defineConfig, loadEnv} from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import fs from 'fs'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import {ElementPlusResolver} from 'unplugin-vue-components/resolvers'
import {VitePWA} from 'vite-plugin-pwa';

function getPackageName(id) {
    const normalizedId = id.replace(/\\/g, '/');
    const nodeModulesMarker = '/node_modules/';
    const index = normalizedId.lastIndexOf(nodeModulesMarker);
    if (index === -1) return null;

    const parts = normalizedId.slice(index + nodeModulesMarker.length).split('/');
    return parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

const elementPlusDeps = new Set([
    '@ctrl/tinycolor',
    '@floating-ui/core',
    '@floating-ui/dom',
    '@floating-ui/utils',
    '@popperjs/core',
    'async-validator',
    'lodash-unified',
    'memoize-one',
    'normalize-wheel-es'
]);

function cleanExternalOutDir(outDir) {
    return {
        name: 'clean-external-out-dir',
        apply: 'build',
        enforce: 'pre',
        configResolved(config) {
            // Vite does not empty output directories outside the project root.
            // Release assets are disposable and must not accumulate stale hashes.
            removeTree(config.build.outDir || outDir);
        }
    };
}

function removeTree(target, root = target) {
    if (target === root && path.basename(target) !== 'dist') {
        throw new Error(`Refusing to clean unexpected release output: ${target}`);
    }
    if (!fs.existsSync(target)) return;
    for (const entry of fs.readdirSync(target)) {
        const child = path.join(target, entry);
        const stat = fs.lstatSync(child);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
            removeTree(child, root);
        } else {
            fs.unlinkSync(child);
        }
    }
    fs.rmdirSync(target);
}

export default defineConfig(({mode}) => {
    const env = loadEnv(mode, process.cwd(), 'VITE')
    const outDir = path.resolve(process.cwd(), env.VITE_OUT_DIR || 'dist')
    return {
        server: {
            host: true,
            port: 3001,
            hmr: true,
        },
        base: env.VITE_STATIC_URL || '/',
        plugins: [
            ...(mode === 'release' ? [cleanExternalOutDir(outDir)] : []),
            vue(),
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
            modulePreload: {
                resolveDependencies(filename, deps) {
                    // Keep draft storage out of the initial HTML preload list.
                    return deps.filter(dep => !/(^|\/)(dexie|db)-/.test(dep));
                }
            },
            rollupOptions: {
                output: {
                    manualChunks(id) {
                        const normalizedId = id.replace(/\\/g, '/');
                        const packageName = getPackageName(id);
                        if (!packageName) return;

                        if (normalizedId.includes('element-plus/es/components/')) {
                            const component = normalizedId.split('element-plus/es/components/')[1]?.split('/')[0];
                            return component ? `element-plus-${component}` : 'element-plus-components';
                        }
                        if (packageName === '@element-plus/icons-vue') return 'element-plus-icons';
                        if (packageName === 'element-plus' || elementPlusDeps.has(packageName)) return 'element-plus-core';
                        if (packageName === 'echarts') return 'echarts';
                        if (packageName === 'dexie') return 'dexie';
                        if (packageName.startsWith('@iconify/')) return 'iconify';
                        if (packageName.startsWith('@vueuse/')) return 'vueuse';
                        if (packageName.startsWith('@vue/')) return 'vue-core';
                        if (packageName === 'vue-router') return 'vue-router';
                        if (packageName === 'vue-i18n' || packageName.startsWith('@intlify/')) return 'vue-i18n';
                        if (packageName === 'pinia' || packageName === 'pinia-plugin-persistedstate') return 'pinia';
                        if (packageName === 'vue') return 'vue-core';
                        if (packageName === 'lodash' || packageName === 'lodash-es') return 'lodash';
                        if (packageName === 'axios') return 'axios';
                        if (packageName === 'dayjs') return 'dayjs';
                        if (packageName === 'nprogress') return 'nprogress';
                        return 'vendor';
                    }
                }
            }
        }
    }
})
