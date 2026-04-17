/**
 * Remote control module for Ambire extension.
 * 
 * This module intercepts userRequests in the extension and forwards them to a 
 * remote server for approval. The server can respond with approve/reject and
 * optionally specify approval details like signer address.
 * 
 * The goal of this module is to enable fully remote-controlled operation of 
 * Ambire wallet when interacting with real-world dapps.
 */

/* eslint-disable no-console */
import { MainController } from '@ambire-common/controllers/main/main'
import { DappProviderRequest } from '@ambire-common/interfaces/dapp'
import { CallsUserRequest, UserRequest } from '@ambire-common/interfaces/userRequest'
import { WindowProps } from '@ambire-common/interfaces/ui'

const SERVER_URL = process.env.REMOTE_CONTROL_URL || 'http://localhost:8765'
export const FAKE_WINDOW: WindowProps = { id: -1 } as WindowProps

export function logRpcRequest(request: DappProviderRequest): void {
  if (!process.env.REMOTE_CONTROL) return
  fetch(`${SERVER_URL}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      { method: request.method, params: request.params, origin: request.session.origin },
      (_, v) => (typeof v === 'bigint' ? v.toString() : v)
    )
  }).catch(() => { })
}


/**
 * Called after mainCtrl is constructed. Subscribes to request changes and
 * forwards new requests to the remote control server.
 * No-op when REMOTE_CONTROL env var is unset.
 */
export function initRemoteControl(mainCtrl: MainController) {
  if (!process.env.REMOTE_CONTROL) return

  let lastSeenRequestId: UserRequest['id'] | null = null

  mainCtrl.requests.onUpdate(() => {
    const request = mainCtrl.requests.currentUserRequest
    if (!request || request.id === lastSeenRequestId) return
    lastSeenRequestId = request.id
    forwardToServer(mainCtrl, request).catch(console.error)
  })
}

/**
 * Wraps windowManager to intercept open/focus/remove calls.
 *
 * In headless mode (REMOTE_CONTROL=headless): open() returns a fake window
 * so no Chrome popup is created.
 *
 * In sidecar mode (REMOTE_CONTROL=sidecar): open() passes through normally,
 * so the human-visible popup still opens alongside the server.
 *
 * focus(-1) and remove(-1) are no-ops for the fake window in both modes.
 */
export function makeRemoteControlWindow(
  windowManager: any,
  originalRemove: (winId: number | 'popup') => Promise<void>
): any {
  const headless = process.env.REMOTE_CONTROL === 'headless'

  return {
    ...windowManager,
    open: headless
      ? async (_options?: any): Promise<WindowProps> => FAKE_WINDOW
      : windowManager.open,
    focus: async (windowProps: WindowProps, params?: any): Promise<WindowProps> => {
      if (windowProps?.id === -1) return FAKE_WINDOW
      return windowManager.focus(windowProps, params)
    },
    remove: async (winId: number | 'popup'): Promise<void> => {
      if (winId === -1) return
      return originalRemove(winId)
    }
  }
}

async function forwardToServer(mainCtrl: MainController, request: UserRequest) {
  try {
    const res = await fetch(`${SERVER_URL}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
    })
    const decision = await res.json()
    await applyDecision(mainCtrl, request, decision)
  } catch (err) {
    console.error('[remote-control] error:', err)
    // Reject only in headless mode so rpcFlow.ts doesn't hang
    if (process.env.REMOTE_CONTROL === 'headless') {
      if (mainCtrl.requests.userRequests.find((r: any) => r.id === request.id)) {
        await mainCtrl.requests.rejectUserRequests('Remote control error', [request.id])
      }
    }
  }
}

async function applyDecision(
  mainCtrl: MainController,
  request: UserRequest,
  decision: { action: 'approve' | 'reject'; signerAddr?: string; signerType?: string }
) {
  // Check if request is still pending (UI may have already resolved it in sidecar mode)
  const stillPending = mainCtrl.requests.userRequests.find((r: any) => r.id === request.id)
  console.log(`[remote-control] applyDecision kind=${request.kind} id=${request.id} stillPending=${!!stillPending} action=${decision.action}`)
  if (!stillPending) return

  if (decision.action === 'reject') {
    await mainCtrl.requests.rejectUserRequests('User rejected the request.', [request.id])
    return
  }

  switch (request.kind) {
    case 'dappConnect': {
      // Normal UI path: rpcFlow.ts:84 creates a Promise keyed on origin; resolving
      // it passes dappToConnect into rpcFlow.ts:98 → dapps.addDapp() (dapps.ts:578).
      // dappToConnect is populated fire-and-forget by dapps.setDappToConnectIfNeeded()
      // (dapps.ts:681) before open() is called, so it is ready by the time the
      // server round-trip completes.
      let dappToConnect = mainCtrl.dapps.dappToConnect
      console.log('[remote-control] dappToConnect:', dappToConnect)
      await mainCtrl.requests.resolveUserRequest(dappToConnect, request.id)
      break
    }
    case 'message':
    case 'siwe':
    case 'typedMessage': {
      // Normal UI path: requests.ts:1111 builds the userRequest; the UI calls
      // signMessage.setSigners() then mainCtrl.handleSignMessage() (main.ts:986),
      // which signs and resolves the dapp promise via resolveSignMessage().
      // For 'siwe', autoLogin may short-circuit before the userRequest is created
      // (requests.ts:1163).
      const keys = mainCtrl.keystore.keys
      const signer = decision.signerAddr
        ? { addr: decision.signerAddr, type: (decision.signerType || 'internal') as any }
        : { addr: keys[0].addr, type: keys[0].type }
      console.log('[remote-control] signing with signer:', signer)
      mainCtrl.signMessage.setSigners([signer])
      await mainCtrl.handleSignMessage()
      break
    }
    case 'calls': {
      // Normal UI path: requests.ts builds a CallsUserRequest with a
      // SignAccountOpController; the UI calls handleSignAndBroadcastAccountOp()
      // (main.ts:848), which signs + broadcasts then resolves via onBroadcastSuccess.
      const { fromRequestId } = (request as CallsUserRequest).signAccountOp
      console.log('[remote-control] signing and broadcasting account op with fromRequestId:', fromRequestId)
      await mainCtrl.handleSignAndBroadcastAccountOp('default', fromRequestId)
      break
    }
    default:
      // Unhandled kinds ('unlock', 'benzin', 'switchAccount', etc.) are resolved
      // with null so rpcFlow doesn't hang.
      //
      // NOTE: 'authorization-7702' (AuthorizationUserRequest) lands here.
      // It is routed through the signMessage controller (signMessage.ts:138) like
      // message/typedMessage, but the actual signing step throws
      // "not implemented" (signMessage.ts:401). Respond with { action: 'reject' }
      // from the server to block EIP-7702 delegation attempts.
      console.log('[remote-control] resolving unknown request kind:', request.kind)
      await mainCtrl.requests.resolveUserRequest(null, request.id)
  }
}