import http from '@/axios/index.js';

export function maintenanceHealth() {
    return http.get('/maintenance/health')
}

export function maintenanceRepair(action) {
    // 重建搜索表/重扫验证码等修复操作耗时较长，放宽超时
    return http.post('/maintenance/repair', {action}, {timeout: 300 * 1000})
}
