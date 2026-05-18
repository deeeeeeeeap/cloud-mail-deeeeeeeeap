import http from '@/axios/index.js';

export function maintenanceHealth() {
    return http.get('/maintenance/health')
}

export function maintenanceRepair(action) {
    return http.post('/maintenance/repair', {action})
}
