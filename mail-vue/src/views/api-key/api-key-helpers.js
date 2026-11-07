export const API_KEY_SCOPES = ['send', 'read', 'users']
export const EXPIRY_PRESETS = ['never', '7', '30', '90', '365', 'custom']
export const EXAMPLE_LANGUAGES = ['curl', 'python', 'node', 'powershell']

const DAY_MS = 24 * 60 * 60 * 1000
const KEY_PLACEHOLDER = 'cmk_your_api_key'

export function resolveExpiresAt(preset, customDate, now = Date.now()) {
    if (preset === 'never') return null
    if (preset === 'custom') {
        if (!customDate) return undefined
        const end = new Date(customDate)
        end.setHours(23, 59, 59, 999)
        return end.toISOString()
    }
    const days = Number(preset)
    return Number.isFinite(days) && days > 0 ? new Date(now + days * DAY_MS).toISOString() : null
}

export function senderSuggestions(domainList = [], allowedSenders = []) {
    const options = domainList
        .map(domain => String(domain || '').replace(/^\*?@/, '').trim().toLowerCase())
        .filter(Boolean)
        .map(domain => `*@${domain}`)
    return [...new Set([...allowedSenders, ...options])]
}

export function exampleSender(allowedSenders = [], domainList = []) {
    const exact = allowedSenders.find(item => !item.startsWith('*@'))
    if (exact) return exact
    const domainPattern = allowedSenders.find(item => item.startsWith('*@'))
    if (domainPattern) return `noreply@${domainPattern.slice(2)}`
    const domain = String(domainList[0] || '').replace(/^\*?@/, '')
    return domain ? `noreply@${domain}` : 'noreply@example.com'
}

export function buildSendExamples({origin, key, sender}) {
    const endpoint = `${origin}/api/public/sendEmail`
    const token = key || KEY_PLACEHOLDER
    const from = sender || 'noreply@example.com'
    const payload = {
        sendEmail: from,
        receiveEmail: ['user@example.org'],
        subject: 'Order shipped',
        text: 'Your order has shipped.'
    }
    const json = JSON.stringify(payload, null, 2)

    return {
        curl: [
            `curl -X POST "${endpoint}" \\`,
            `  -H "Authorization: Bearer ${token}" \\`,
            '  -H "Content-Type: application/json" \\',
            '  -H "Idempotency-Key: order-1001" \\',
            `  -d '${json.replace(/\n/g, '\n  ')}'`,
            '',
            '# Check delivery status later',
            `curl "${origin}/api/public/emailStatus?emailIds=123" \\`,
            `  -H "Authorization: Bearer ${token}"`
        ].join('\n'),
        python: [
            'import requests',
            '',
            'resp = requests.post(',
            `    "${endpoint}",`,
            '    headers={',
            `        "Authorization": "Bearer ${token}",`,
            '        "Idempotency-Key": "order-1001",',
            '    },',
            '    json={',
            `        "sendEmail": "${from}",`,
            '        "receiveEmail": ["user@example.org"],',
            '        "subject": "Order shipped",',
            '        "text": "Your order has shipped.",',
            '    },',
            '    timeout=30,',
            ')',
            'data = resp.json()',
            'if data["code"] != 200:',
            '    raise RuntimeError(data["message"])',
            'print(data["data"][0]["emailId"])'
        ].join('\n'),
        node: [
            `const res = await fetch('${endpoint}', {`,
            "  method: 'POST',",
            '  headers: {',
            `    Authorization: 'Bearer ${token}',`,
            "    'Content-Type': 'application/json',",
            "    'Idempotency-Key': 'order-1001'",
            '  },',
            `  body: JSON.stringify(${JSON.stringify(payload, null, 2).replace(/\n/g, '\n  ')})`,
            '});',
            'const data = await res.json();',
            'if (data.code !== 200) throw new Error(data.message);',
            'console.log(data.data[0].emailId);'
        ].join('\n'),
        powershell: [
            '$body = @{',
            `  sendEmail    = '${from}'`,
            "  receiveEmail = @('user@example.org')",
            "  subject      = 'Order shipped'",
            "  text         = 'Your order has shipped.'",
            '} | ConvertTo-Json',
            `Invoke-RestMethod -Method Post -Uri '${endpoint}' \``,
            `  -Headers @{ Authorization = 'Bearer ${token}'; 'Idempotency-Key' = 'order-1001' } \``,
            "  -ContentType 'application/json; charset=utf-8' `",
            '  -Body ([Text.Encoding]::UTF8.GetBytes($body))'
        ].join('\n')
    }
}

export function keyState(item, now = Date.now()) {
    if (item.status !== 0) return 'disabled'
    if (item.expiresAt && Date.parse(item.expiresAt) <= now) return 'expired'
    return 'active'
}
