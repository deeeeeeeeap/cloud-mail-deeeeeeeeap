// 已带转发前缀（包括其他客户端写的 FW:、转发：等）时不再叠加
const FORWARD_PREFIX = /^(fwd?|转发|轉寄|転送)\s*[:：]/i

export function forwardSubject(subject) {
  subject = subject || ''
  return FORWARD_PREFIX.test(subject) ? subject : `Fwd: ${subject}`
}
