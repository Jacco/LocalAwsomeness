
// *****************************************************************************
// ***                                                                       ***
// *** IAM                                                                   ***
// ***                                                                       ***
// *****************************************************************************

import { readFileSync } from "fs"

export enum PolicyScope {
  All = "All",
  AWS = "AWS",
  Local = "Local",
}

export interface Policy {
  PolicyId: string
  DefaultVersion: string
}

export function listPolicies(account: string, scope: PolicyScope = PolicyScope.All): { [name: string]: Policy } {
  const policies: { [name: string]: Policy } = JSON.parse(readFileSync('db/awsiam.json').toString())
  return policies
}
