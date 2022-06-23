'use strict'; (async () => {
const CONFIG = window.CONFIG

//--[ OAuth ]--------------------------------------
const STATE_PREFIX = 'oauth'

function sleep(time) {
  return new Promise((resolve) => setTimeout(resolve, time))
}

function never_returns() {
  return new Promise(() => {})
}

function random() {
  const array = new Uint32Array(32)
  window.crypto.getRandomValues(array)
  return Array.from(array, dec => ('0' + dec.toString(16)).substr(-2)).join('')
}

function sha256(plain) {
  const encoder = new TextEncoder()
  const data = encoder.encode(plain)
  return window.crypto.subtle.digest('SHA-256', data)
}

function base64url_encode(str) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function pkce_verifier_to_challenge(v) {
  const hashed = await sha256(v)
  return base64url_encode(hashed)
}

async function redirect_to_oauth_authorization() {
  const state = random()
  const code_verifier = random()

  sessionStorage.setItem(`${STATE_PREFIX}:state`, state)
  sessionStorage.setItem(`${STATE_PREFIX}:pkce_code_verifier`, code_verifier)

  // Build the authorization URL
  const param = new URLSearchParams()
  param.append('response_type', 'code')
  param.append('client_id', CONFIG.client_id)
  param.append('state', state)
  param.append('scope', CONFIG.requested_scopes)
  param.append('redirect_uri', CONFIG.redirect_uri)
  param.append('code_challenge', await pkce_verifier_to_challenge(code_verifier))
  param.append('code_challenge_method', 'S256')

  // Redirect to the authorization server
  window.location.href = `${CONFIG.authorization_endpoint}?${param}`
  await never_returns()
}

async function handle_oauth_return() {
  const u = new URL(window.location)
  const p = key => u.searchParams.get(key)

  const state = sessionStorage.getItem(`${STATE_PREFIX}:state`)
  const code_verifier = sessionStorage.getItem(`${STATE_PREFIX}:pkce_code_verifier`)

  // Clean these up since we don't need them anymore
  sessionStorage.removeItem(`${STATE_PREFIX}:state`)
  sessionStorage.removeItem(`${STATE_PREFIX}:pkce_code_verifier`)

  // If there's no oauth 'state' parameter, there's nothing to do.
  if (!p("state"))
    return null

  if (state != p("state")) {
    // If the state doesn't match the locally saved state,
    // we have to abort the flow. Someone might have started
    // it without our knowledge.
    console.log("Invalid state")
    return null
  } else if (p("error")) {
    // If there's an error response, print it out
    alert(p("error_description"))
    window.location.href = CONFIG.web_root
    await never_returns()
  } else if (p("code")) {
    // Exchange the authorization code for an access token
    const param = new URLSearchParams()
    param.append('grant_type', 'authorization_code')
    param.append('code', p("code"))
    param.append('client_id', CONFIG.client_id)
    param.append('redirect_uri', CONFIG.redirect_uri)
    param.append('code_verifier', code_verifier)
    const resp = await fetch(CONFIG.token_endpoint, {
      method: 'POST',
      body: param,
    })
    let data = await resp.json()
    return data.access_token
  }
}
//----------------------

async function wipe_login_and_goto(target) {
  console.log("removing access token")
  try {
    await fetch(CONFIG.api_root + 'session/destroy', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionStorage.getItem('access_token')}`,
      }
    })
  } catch (e) {
    console.log('cannot destroy session', e)
  }
  sessionStorage.removeItem('access_token')
  window.location.href = target || CONFIG.app_root
  await never_returns()
}

async function logout(force_hosted) {
  const return_to_hosted_on_logout = sessionStorage.getItem('return-to-hosted-on-logout') != null
  if (return_to_hosted_on_logout || force_hosted) {
    sessionStorage.removeItem('return-to-hosted-on-logout')
    await wipe_login_and_goto(CONFIG.web_root)
  } else {
    await wipe_login_and_goto()
  }
}

async function probe_login_state(force_login) {
  let access_token = await handle_oauth_return()
  if (access_token) {
    sessionStorage.setItem('access_token', access_token)

    let next = sessionStorage.getItem('next')
    if (next) {
      sessionStorage.removeItem('next')
      window.history.replaceState({}, '', CONFIG.app_root + next)
    } else {
      window.history.replaceState({}, '', CONFIG.app_root)
    }
    return access_token
  }

  access_token = sessionStorage.getItem('access_token')
  if (access_token) {
    return access_token
  }

  const u = new URL(window.location)
  if (u.searchParams.get("source") == "ib") {
    sessionStorage.setItem('return-to-hosted-on-logout', '1')
    sessionStorage.setItem('next', `${u.search}${u.hash}`)
    return await redirect_to_oauth_authorization()
  }

  if (force_login) {
    return await redirect_to_oauth_authorization()
  }

  return null
}

async function http(method, path, body) {
  let headers = {}
  let bearer = sessionStorage.getItem('access_token')
  if (bearer) {
    headers['Authorization'] = `Bearer ${bearer}`
  }
  let params = {
    method: method,
    headers: headers,
  }
  if (body && body instanceof FormData) {
    params.body = body
  } else if (body) {
    let formdata = new FormData()
    for (let k in body) {
      formdata.append(k, body[k])
    }
    params.body = formdata
  }
  while (true) {
    let r = await fetch(window.CONFIG.api_root + path, params)
    if (r.status == 429) {
      let delay = parseInt(r.headers.get('Retry-After'))
      if (isNaN(delay))
        delay = 5
      await sleep(delay * 1000)
      continue
    } else if (r.status == 401) {
      await wipe_login_and_goto()
    } else if (r.status == 403) {
      alert(`Access to ${path} denied`)
      return null
    }
    return await r.json()
  }
}

// ------------------------------------------------------------------------

await probe_login_state(/* force_login = */ true)

const PHOTOPEA_ORIGIN = 'https://www.photopea.com'

class PhotopeaRPC{
  constructor() {
    this._resolvers = []
    this._values = []
    window.addEventListener("message", e => {
      if (e.origin != PHOTOPEA_ORIGIN)
        return
      let value = e.data
      this._values.push(value)
      if (value == 'done' || value instanceof ArrayBuffer) {
        let next = this._resolvers.shift()
        next(this._values)
        this._values = []
      }
    })
  }
  async wait(fn) {
    let response = new Promise(resolve => {
      this._resolvers.push(resolve)
    })
    fn && await fn()
    return response
  }
}

const hash_args = new URLSearchParams(window.location.hash.substr(1))
const asset_id = hash_args.get('asset_id')
if (!asset_id) {
  alert('Open this app by clicking on the "Photopea Image Editor" button next to any image asset')
  window.location.href = CONFIG.web_root
}

const asset_download = await http('GET', `asset/${asset_id}/download`)

const config = {
  environment: {
    localsave: false,
    customIO: {
      save: {
        'image/png': 'app.activeDocument.saveToOE("png")',
        'image/jpeg': 'app.activeDocument.saveToOE("jpg")',
      }[asset_download.mimetype],
    },
    menus: [
      [0, 0, 0, 0, 0, 1],
      1, 1, 1, 1, 1, 1, 1, 0,
    ],
    phrases: [
      [1, 2], 'Save Asset & Close'
    ],
  }
}

const pea = new PhotopeaRPC()

const pea_iframe = document.getElementById('mainframe')
const pea_window = pea_iframe.contentWindow

await pea.wait(() => {
  pea_iframe.src = `https://www.photopea.com/#${encodeURI(JSON.stringify(config))}`
})

console.log('init complete')

const asset_resp = await fetch(asset_download.download_url)
const asset_data = await asset_resp.arrayBuffer()

await pea.wait(() => {
  pea_window.postMessage(asset_data, PHOTOPEA_ORIGIN)
})

await pea.wait(() => {
  pea_window.postMessage(`app.activeDocument.name=${JSON.stringify(asset_download.filename)}`, PHOTOPEA_ORIGIN)
})

console.log('load complete')

const [saved_image] = await pea.wait()
const upload = new FormData()
upload.append('file', new Blob([saved_image], {type: asset_download.mimetype}), asset_download.filename)
await http('POST', 'asset/upload', upload)
await wipe_login_and_goto(`${CONFIG.web_root}/assets`)

})()
