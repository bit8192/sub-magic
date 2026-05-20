export function parseGeositeDat(bytes) {
  const result = []
  const decoder = new TextDecoder('utf-8', { fatal: false })

  function readVarint(arr, pos) {
    let val = 0, shift = 0, b
    do {
      if (pos.i >= arr.length) return -1
      b = arr[pos.i++]
      val |= (b & 0x7f) << shift
      shift += 7
    } while (b & 0x80)
    return val
  }

  {
    const pos = { i: 0 }
    while (pos.i < bytes.length) {
      const tag = readVarint(bytes, pos)
      if (tag === -1 || tag === 0) break
      const fieldNum = tag >> 3
      const wireType = tag & 0x7
      if (wireType !== 2) {
        if (wireType === 0) { if (readVarint(bytes, pos) === -1) break }
        else if (wireType === 5) pos.i += 4
        else if (wireType === 1) pos.i += 8
        else break
        continue
      }
      const len = readVarint(bytes, pos)
      if (len === -1 || pos.i + len > bytes.length) break
      if (fieldNum === 1) {
        const gs = parseGeositeProtobuf(bytes.slice(pos.i, pos.i + len), decoder)
        if (gs && gs.name && !result.some(c => c.name === gs.name)) {
          result.push(gs)
        }
      }
      pos.i += len
    }
  }

  if (result.length === 0) {
    let offset = 0
    while (offset + 4 <= bytes.length) {
      const nameLen = bytes[offset] | (bytes[offset + 1] << 8)
      offset += 2
      if (nameLen === 0 || offset + nameLen > bytes.length) break
      let name = ''
      try { name = decoder.decode(bytes.slice(offset, offset + nameLen)) } catch {}
      offset += nameLen
      if (!name || name.length > 128 || !/^[a-zA-Z0-9@._\u{80}-\u{FFFF}-]+$/u.test(name)) {
        if (offset + 2 > bytes.length) break
        const dataLen = bytes[offset] | (bytes[offset + 1] << 8)
        offset += 2 + dataLen
        continue
      }
      if (offset + 2 > bytes.length) break
      const dataLen = bytes[offset] | (bytes[offset + 1] << 8)
      offset += 2
      if (dataLen === 0 || offset + dataLen > bytes.length) break
      if (!result.some(c => c.name === name)) {
        const gs = parseGeositeProtobuf(bytes.slice(offset, offset + dataLen), decoder)
        result.push({ name, domains: gs ? gs.domains : [] })
      }
      offset += dataLen
    }
  }

  if (result.length === 0) {
    let offset = 0
    try {
      while (offset < bytes.length) {
        let tag = 0, shift = 0
        while (offset < bytes.length) {
          const b = bytes[offset++]
          tag |= (b & 0x7f) << shift
          shift += 7
          if (!(b & 0x80)) break
        }
        if (tag === 0) break
        let len = 0; shift = 0
        while (offset < bytes.length) {
          const b = bytes[offset++]
          len |= (b & 0x7f) << shift
          shift += 7
          if (!(b & 0x80)) break
        }
        if (len === 0 || offset + len > bytes.length) break
        const slice = bytes.slice(offset, offset + len)
        let str = ''
        try { str = decoder.decode(slice) } catch {}
        if (str && str.length >= 1 && str.length <= 128 && /^[a-zA-Z0-9@._-]+$/.test(str)) {
          if (!result.some(c => c.name === str)) result.push({ name: str, domains: [] })
        }
        offset += len
      }
    } catch {}
  }

  if (result.length === 0) {
    let buf = ''
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i]
      if (c >= 32 && c <= 126) {
        buf += String.fromCharCode(c)
      } else {
        if (buf.length >= 2 && buf.length <= 128 && /^[a-zA-Z0-9@._-]+$/.test(buf) && !buf.includes('.')) {
          if (!result.some(c => c.name === buf)) result.push({ name: buf, domains: [] })
        }
        buf = ''
      }
    }
  }

  return result.sort((a, b) => a.name.localeCompare(b.name))
}

export function parseGeositeProtobuf(buf, decoder) {
  function readVarint(arr, pos) {
    let val = 0, shift = 0, b
    do {
      if (pos.i >= arr.length) return -1
      b = arr[pos.i++]
      val |= (b & 0x7f) << shift
      shift += 7
    } while (b & 0x80)
    return val
  }

  const pos = { i: 0 }
  let name = null
  const domains = []

  while (pos.i < buf.length) {
    const tag = readVarint(buf, pos)
    if (tag === -1 || tag === 0) break
    const fieldNum = tag >> 3
    const wireType = tag & 0x7

    if (wireType === 2) {
      const len = readVarint(buf, pos)
      if (len === -1 || pos.i + len > buf.length) break
      if (fieldNum === 1) {
        try { name = decoder.decode(buf.slice(pos.i, pos.i + len)) } catch {}
      } else if (fieldNum === 2) {
        parseSiteMessage(buf.slice(pos.i, pos.i + len), decoder, domains)
      }
      pos.i += len
    } else if (wireType === 0) {
      if (readVarint(buf, pos) === -1) break
    } else if (wireType === 5) {
      pos.i += 4
    } else if (wireType === 1) {
      pos.i += 8
    } else break
  }

  return name ? { name, domains } : null
}

export function parseSiteMessage(buf, decoder, domains) {
  function readVarint(arr, pos) {
    let val = 0, shift = 0, b
    do {
      if (pos.i >= arr.length) return
      b = arr[pos.i++]
      val |= (b & 0x7f) << shift
      shift += 7
    } while (b & 0x80)
    return val
  }

  const pos = { i: 0 }
  while (pos.i < buf.length) {
    const tag = readVarint(buf, pos)
    if (tag === undefined || tag === 0) break
    const fieldNum = tag >> 3
    const wireType = tag & 0x7

    if (wireType === 2) {
      const len = readVarint(buf, pos)
      if (len === undefined || pos.i + len > buf.length) break
      if (fieldNum === 2) {
        try {
          const str = decoder.decode(buf.slice(pos.i, pos.i + len))
          if (str && str.length <= 255) domains.push(str)
        } catch {}
      }
      pos.i += len
    } else if (wireType === 0) {
      if (readVarint(buf, pos) === undefined) break
    } else if (wireType === 5) {
      pos.i += 4
    } else if (wireType === 1) {
      pos.i += 8
    } else break
  }
}
