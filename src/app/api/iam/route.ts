import { getRequestInfo, okxml } from "../common";
import { listPolicies } from "./listPolicies";
import { listUsers } from "./listUsers";

export async function POST(request: Request) {
  const { principalAccount } = getRequestInfo(request)
  const body = await request.text()
  const prms = new URLSearchParams(body)
  const action = prms.get('Action')
  // TODO Version Prefix MaxItem and also Marker
  // TODO version
  switch (action) {
      case 'ListUsers'   : return listUsers()
      case 'ListPolicies': return listPolicies(principalAccount)
      default: throw Error('Unknown action')
  }
}
