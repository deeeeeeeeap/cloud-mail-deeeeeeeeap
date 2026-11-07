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

// 只给稳定、体积大的依赖分组；Element Plus 组件 JS 由 Rollup 按路由自然拆分
const VUE_VENDOR = new Set(['vue', 'vue-router', 'pinia', 'pinia-plugin-persistedstate', 'vue-i18n']);
// 按需加载的小模块固定为独立 chunk，避免被碎片合并并进首屏共享 chunk
const LAZY_PINS = [
    [/\/src\/utils\/turnstile-loader\.js$/, 'turnstile-loader'],
    [/\/src\/components\/tiny-editor\/loader\.js$/, 'tiny-editor-loader'],
    // 界面文案与同语言的 Element Plus 语言包合成一个 chunk，启动时按当前语言只取一次
    [/\/src\/i18n\/zh\.js$|\/element-plus\/es\/locale\/lang\/zh-cn\.mjs$/, 'locale-zh'],
    [/\/src\/i18n\/zh-tw\.js$|\/element-plus\/es\/locale\/lang\/zh-tw\.mjs$/, 'locale-zh-tw'],
    [/\/src\/i18n\/en\.js$/, 'locale-en'],
    [/\/src\/i18n\/ja\.js$|\/element-plus\/es\/locale\/lang\/ja\.mjs$/, 'locale-ja'],
];

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
        define: {
            // vue-i18n 只用 Composition API，生产环境不带 devtools 集成
            __VUE_I18N_FULL_INSTALL__: true,
            __VUE_I18N_LEGACY_API__: false,
            __INTLIFY_PROD_DEVTOOLS__: false,
        },
        build: {
            target: 'es2022',
            outDir: env.VITE_OUT_DIR || 'dist',
            emptyOutDir: true,
            modulePreload: {
                resolveDependencies(filename, deps) {
                    // Keep draft storage out of the initial HTML preload list.
                    return deps.filter(dep => !/(^|\/)(dexie|db)-/.test(dep));
                }
            },
            rollupOptions: {
                output: {
                    // 合并小于 8 KB 的碎片 chunk（Rollup 只合并无副作用的 chunk，手动 chunk 不参与合并）
                    experimentalMinChunkSize: 8 * 1024,
                    manualChunks(id) {
                        const normalizedId = id.replace(/\\/g, '/');
                        // CJS 互操作 helper 必须留在首屏 chunk，否则会把所在的 dayjs/dexie chunk 拖进首屏
                        if (normalizedId.includes('commonjsHelpers')) return 'vue-vendor';
                        for (const [pattern, name] of LAZY_PINS) {
                            if (pattern.test(normalizedId)) return name;
                        }
                        const packageName = getPackageName(id);
                        if (!packageName) return;

                        if (packageName === 'echarts' || packageName === 'zrender' || packageName === 'tslib') return 'echarts';
                        if (packageName === 'dexie') return 'dexie';
                        // Element Plus CSS 挂在入口最先导入的 vue-vendor 上，保持它先于 style.css 的层叠顺序
                        if (packageName === 'element-plus' && /\.css(\?|$)/.test(normalizedId)) return 'vue-vendor';
                        if (VUE_VENDOR.has(packageName) || packageName.startsWith('@vue/') || packageName.startsWith('@intlify/')) return 'vue-vendor';
                        // 其余依赖（Element Plus JS 及其 barrel、lodash-es、vueuse、axios、dayjs 等）不分组：
                        // barrel 一旦进入手动 chunk，会把它静态引用的全部组件一起拖进去
                    }
                }
            }
        }
    }
})
