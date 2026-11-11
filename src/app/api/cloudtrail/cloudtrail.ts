import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

/**
 * Minimal CloudTrail for debugging: logs all API calls (authorized and denied) to data directory.
 * Not AWS-compliant, just useful for understanding what happened during testing.
 */

export interface CloudTrailEvent {
  // ISO 8601 timestamp
  timestamp: string
  // The AWS principal making the call (role ARN or user ARN)
  principal: string
  // AWS service (lambda, iam, sts, logs, etc.)
  service: string
  // API action (GetRole, PutRolePolicy, etc.)
  action: string
  // Primary resource being operated on (ARN)
  resource: string
  // Additional resource ARNs if applicable
  resources?: string[]
  // 'allow' | 'deny' - whether authorization check passed
  authorizationDecision: 'allow' | 'deny'
  // Reason if denied
  authorizationReason?: string
  // Account ID
  account: string
  // AWS region
  region: string
  // Request parameters (sanitized, no secrets)
  parameters?: Record<string, unknown>
  // Error code if operation failed (in addition to authorization)
  errorCode?: string
  // Error message if operation failed
  errorMessage?: string
}

const dbRoot = process.env.JPK_DB_ROOT || 'db'

function getCloudTrailPath(account: string): string {
  const trailDir = join(dbRoot, 'cloudtrail')
  if (!existsSync(trailDir)) {
    mkdirSync(trailDir, { recursive: true })
  }
  return join(trailDir, `${account}-events.jsonl`)
}

/**
 * Log an API call to CloudTrail. Called from registry.ts after authorization check.
 */
export function logCloudTrailEvent(event: CloudTrailEvent): void {
  try {
    const path = getCloudTrailPath(event.account)
    appendFileSync(path, JSON.stringify(event) + '\n', 'utf8')
  } catch (error) {
    // Silently fail - CloudTrail logging should never break the application
    // In real code, this would go to stderr but we don't want to pollute Lambda output
  }
}

/**
 * Read CloudTrail events for debugging.
 * Returns events matching optional filters.
 */
export function readCloudTrailEvents(
  account: string,
  filters?: {
    principal?: string
    service?: string
    action?: string
    resource?: string
    authorizationDecision?: 'allow' | 'deny'
    since?: Date
    until?: Date
  }
): CloudTrailEvent[] {
  try {
    const path = getCloudTrailPath(account)
    if (!existsSync(path)) {
      return []
    }

    const fs = require('fs')
    const content = fs.readFileSync(path, 'utf8')
    const events = content.trim().split('\n').filter(Boolean).map((line: string) => JSON.parse(line) as CloudTrailEvent)

    if (!filters) return events

    return events.filter(event => {
      if (filters.principal && !event.principal.includes(filters.principal)) return false
      if (filters.service && event.service !== filters.service) return false
      if (filters.action && event.action !== filters.action) return false
      if (filters.resource && event.resource !== filters.resource && !event.resources?.includes(filters.resource)) return false
      if (filters.authorizationDecision && event.authorizationDecision !== filters.authorizationDecision) return false

      if (filters.since) {
        const eventTime = new Date(event.timestamp)
        if (eventTime < filters.since) return false
      }
      if (filters.until) {
        const eventTime = new Date(event.timestamp)
        if (eventTime > filters.until) return false
      }

      return true
    })
  } catch (error) {
    return []
  }
}

/**
 * Clear CloudTrail events (for testing).
 */
export function clearCloudTrailEvents(account: string): void {
  try {
    const path = getCloudTrailPath(account)
    if (existsSync(path)) {
      const fs = require('fs')
      fs.unlinkSync(path)
    }
  } catch (error) {
    // Ignore
  }
}
