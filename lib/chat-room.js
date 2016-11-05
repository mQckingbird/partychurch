import crypto from 'crypto'
import fs from 'fs'
import cuid from 'cuid'
import frameConverter from './frame-converter'
import twitterText from 'twitter-text'

// TODO(forivall): move this to a standalone module
// Helps protect against ImageMagick abuse
// Magic values taken from https://en.wikipedia.org/wiki/List_of_file_signatures
function verifyJpegHeader(buffer) {
  if (buffer.length < 12) {
    return false
  }

  const firstDword = buffer.readUInt32BE(0)
  if ((firstDword & 0xFFFFFF00) >>> 0 !== 0xFFD8FF00) {
    return false
  }
  const fourthByte = firstDword & 0xFF
  if (fourthByte === 0xD8) {
    return true
  } else if (fourthByte === 0xE0) {
    const jfif = buffer.readUInt32BE(6)
    const additional = buffer.readUInt16BE(10)
    if (jfif !== 0x4A464946 || additional !== 0x0001) {
      return false
    }
    return true
  } else if (fourthByte === 0xE1) {
    const exif = buffer.readUInt32BE(6)
    const additional = buffer.readUInt16BE(10)
    if (exif !== 0x45786966 || additional !== 0x0000) {
      return false
    }
    return true
  } else {
    return false
  }
}

function transformText(text) {
  const sanitized = text.slice(0, 250).replace(/[\r\n\t]/, '')
  const entities =
      twitterText.extractEntitiesWithIndices(sanitized, { extractUrlsWithoutProtocol: true})
  const linkified = twitterText.autoLinkEntities(sanitized, entities, {
    htmlEscapeNonEntities: true,
    targetBlank: true,
    usernameIncludeSymbol: true,
  })

  return linkified
}

// Build a quick lookup for expiry times (including gain factor), indexed by the number of
// messages in the history when making the check
function buildExpiryTimeLookup(historyLimit, historyExpiryMs, expiryGainFactor) {
  const expiryTimes = [0]
  for (let i = 1; i <= historyLimit; i++) {
    expiryTimes[i] = historyExpiryMs * (expiryGainFactor ** (historyLimit - i))
  }
  return expiryTimes
}

export default class ChatRoom {
  constructor(sockets, name, options) {
    this.name = name
    this.sockets = sockets
    this.historyLimit = options.historyLimit

    this.expiryTimes = buildExpiryTimeLookup(
      this.historyLimit,
      options.historyExpiryMs,
      options.expiryGainFactor
    )

    this.history = [{
      chat: this.createChat(
        crypto.createHash('md5').update('butts').digest('hex'), 'butts'
      ),
      videos: {
        jpg: fs.readFileSync(__dirname + '/../public/butts.jpg')
      }
    }]
  }

  get io() {return this.sockets.io}
  get ffmpegRunner() {return this.sockets.ffmpegRunner}
  get userIdMap() {return this.sockets.userIdMap}
  get _messageThrottle() {return this.sockets._messageThrottle}

  createChat(userId, text = '', frames = 10) {
    const transformedText = transformText(text)
    return {
      key: cuid(),
      text: transformedText,
      sent: Date.now(),
      userId,
      frames,
      from: 'partychurch',
    }
  }

  handleJoin(socket, videoType) {
    // TODO(forivall): keep track of these listeners so we can unbind
    socket
    .on('chat', (message, frames) => this.handleIncoming(socket, message, frames))
    .on('message', message => this.handleIncomingLegacy(socket, message))

    socket.join(videoType)
    this.sendHistory(socket)
  }

  sendHistory(socket) {
    const videoType = 'jpg'
    const now = Date.now()
    while (this.history.length &&
        now - this.history[0].chat.sent > this.expiryTimes[this.history.length]) {
      this.history.shift()
    }

    for (let i = 0; i < this.history.length; i++) {
      this.emitChatInFormat(
          socket, this.history[i].chat, this.history[i].videos[videoType], videoType)
    }
  }

  addToHistory(chat, videos) {
    this.history.push({ chat, videos })
    if (this.history.length > this.historyLimit) {
      this.history.shift()
    }

    this.emitChat(chat, videos)
  }

  handleIncoming(socket, message, frames) {
    if (!this.userIdMap.has(socket)) {
      socket.emit('error', 'no fingerprint set')
      return
    }
    if (!message) {
      socket.emit('error', 'invalid message')
      return
    }
    const ack = {
      key: '' + message.ack
    }

    this._messageThrottle.rateLimit(this.userIdMap.get(socket), (err, limited) => {
      if (err) {
        console.error('Error ratelimiting message:', err)
      } else if (limited) {
        ack.err = 'exceeded message limit'
        socket.emit('ack', ack)
        return
      }

      // TODO(tec27): allowing variable frame counts should be fairly easy, we should do this
      if (!frames || !Array.isArray(frames) || frames.length > 100 ||
          !frames.every(f => verifyJpegHeader(f))) {
        ack.err = 'invalid frames'
        socket.emit('ack', ack)
        return
      }
      if (!message.format || message.format !== 'image/jpeg') {
        ack.err = 'invalid frame format'
        socket.emit('ack', ack)
        return
      }

      frameConverter(frames, message.format, this.ffmpegRunner, (err, video) => {
        if (err) {
          console.error('error: ' + err)
          ack.err = 'unable to convert frames'
          socket.emit('ack', ack)
          return
        }

        const chat = this.createChat(this.userIdMap.get(socket), message.text)
        socket.emit('ack', ack)
        this.addToHistory(chat, video)
      })
    })
  }

  emitChat(chatData, videos) {
    // TODO(forivall): send mp4 for loooong streamer vids
    // TODO(forivall): send to individual rooms per streamer
    const videoType = 'jpg'
    this.emitChatInFormat(this.io.to(videoType), chatData, videos[videoType], videoType)
  }

  emitChatInFormat(target, data, video, videoType) {
    const packet = Object.create(data)
    packet.video = video
    packet.videoType = videoType
    packet.videoMime = 'image/jpeg'
    target.emit('chat', packet)
  }
}