import { readFileSync } from "fs"

interface RegionData {
  prefix: string
  zones: string[]
  domain?: string
}

export interface AvailabilityZone {
  name: string
  id: string
}

let regions: Record<string, RegionData> | undefined

function regionData(region: string): RegionData {
  regions ??= JSON.parse(readFileSync('data/aws/regions.json').toString()).regions
  return regions![region]
}

export function availabilityZones(region: string): AvailabilityZone[] {
  const data = regionData(region)
  return data.zones.map((letter, i) => ({ name: `${region}${letter}`, id: `${data.prefix}-az${i + 1}` }))
}

export function regionDomain(region: string): string {
  return regionData(region).domain ?? `${region}.compute.internal`
}
