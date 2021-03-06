import 'waypoints/lib/noframework.waypoints'
import filmstrip2gif from 'filmstrip2gif'
import EventSubscriber from './event-subscriber'
import createIdenticon from './identicon'
import icons from './icons'
import createDropdown from './dropdown'
import localeTime from './locale-time'
import theme from './theme'
import {BLANK_IMAGE} from './constants'

import template from './views/message.pug'

const Waypoint = window.Waypoint

const MESSAGE_LIMIT = 30
  , MAX_RECYCLED = 0
  , NUM_VIDEO_FRAMES = 10
  , FILMSTRIP_DURATION = 0.92
  , FILMSTRIP_HORIZONTAL = false

const MESSAGE_HTML = template({BLANK_IMAGE})

class Message {
  constructor(owner) {
    this._disposed = false
    this._userId = null
    this._srcUrl = null
    this._animationRequest = null
    this.owner = owner

    this.root = document.createElement('li')
    this.root.innerHTML = MESSAGE_HTML
    this.videoContainer = this.root.querySelector('.video-container')
    this.filmstrip = this.root.querySelector('.filmstrip')
    this.saveButton = this.root.querySelector('.save')
    this.chatText = this.root.querySelector('p')
    this.timestamp = this.root.querySelector('time')
    // placeholder div so it can be replaced with the real thing when bound
    this.identicon = this.root.querySelector('.identicon')
    this.messageOverflow = this.root.querySelector('.message-overflow')

    this.waypoints = [
      new Waypoint({
        element: this.root,
        offset: () => -this.root.clientHeight,
        handler: direction => this.handleWaypoint('bottom', direction),
      }),
      new Waypoint({
        element: this.root,
        offset: '100%',
        handler: direction => this.handleWaypoint('top', direction),
      }),
    ]
    for (const waypoint of this.waypoints) {
      waypoint.disable()
    }

    this.saveButton.addEventListener('click', () => this.saveGif())
    this.dropdown = createDropdown(this.messageOverflow.parentElement, {
      mute: () => this.mute()
    })
  }

  bind({ key, text, sent, userId, from, video, videoMime, videoType }, myId) {
    this._throwIfDisposed()
    this.unbind()

    const blob = new window.Blob([ video ], { type: videoMime })
    this._srcUrl = window.URL.createObjectURL(blob)
    this.filmstrip.src = this._srcUrl

    this.chatText.innerHTML = text

    const sentDate = new Date(sent)
    this.timestamp.datetime = sentDate.toISOString()
    this.timestamp.innerHTML = localeTime(sentDate)

    if (myId === userId) {
      // No mute menu for yourself
      this.messageOverflow.setAttribute('disabled', true)
    }
    this._userId = userId
    this.refreshIdenticon()

    this._key = key
    this._animationRequest = window.requestAnimationFrame(() => {
      this._animationRequest = null
      for (const waypoint of this.waypoints) {
        waypoint.enable()
      }
    })
  }

  refreshIdenticon() {
    const newIdenticon = createIdenticon(this._userId)
    this.identicon.parentElement.replaceChild(newIdenticon, this.identicon)
    this.identicon = newIdenticon
  }

  unbind() {
    this._throwIfDisposed()

    if (this._animationRequest) {
      window.cancelAnimationFrame(this._animationRequest)
      this._animationRequest = null
    }

    this._userId = null
    this._key = null
    this.dropdown.close()

    this.filmstrip.src = BLANK_IMAGE

    if (this._srcUrl) {
      window.URL.revokeObjectURL(this._srcUrl)
      this._srcUrl = null
    }

    this.messageOverflow.removeAttribute('disabled')

    for (const waypoint of this.waypoints) {
      waypoint.disable()
    }
  }

  dispose() {
    this._throwIfDisposed()
    this._disposed = true

    for (const waypoint of this.waypoints) {
      waypoint.destroy()
    }
    this.waypoints.length = 0
  }

  saveGif() {
    this._throwIfDisposed()
    this.saveButton.disabled = true
    this.owner.trackSaveGif()

    const cb = (err, gifBlob) => {
      this.saveButton.disabled = false
      if (err) {
        // TODO(tec27): need a good way to display this error to users
        console.error('Error creating GIF:')
        console.dir(err)
        return
      }

      const url = window.URL.createObjectURL(gifBlob)
        , link = document.createElement('a')
        , click = document.createEvent('MouseEvents')

      link.href = url
      link.download = Date.now() + '.gif'
      click.initMouseEvent('click', true, true, window, 0, 0, 0, 0, 0,
          false, false, false, false, 0, null)
      link.dispatchEvent(click)
      setTimeout(() => window.URL.revokeObjectURL(url), 100)
    }

    filmstrip2gif(this._srcUrl, FILMSTRIP_DURATION, NUM_VIDEO_FRAMES, FILMSTRIP_HORIZONTAL, cb)
  }

  mute() {
    this._throwIfDisposed()
    this.owner.muteUser(this._userId)
  }

  handleWaypoint(side, direction) {
    if ((side === 'top' && direction === 'down') || (side === 'bottom' && direction === 'up')) {
      this.root.className = 'displayed'
    } else {
      this.root.className = ''
    }
    // TODO(tec27): tell owner about this so it can recycle on scrolling?
  }

  get elem() {
    return this.root
  }

  get userId() {
    return this._userId
  }

  get key() {
    return this._key
  }

  _throwIfDisposed() {
    if (this._disposed) throw new Error('Message already disposed!')
  }
}

class MessageList extends EventSubscriber {
  constructor(listElem, muteSet, tracker) {
    super()
    this._onThemeChange = this._onThemeChange.bind(this)

    this.elem = listElem
    this.messages = []
    this.messageKeys = new Set()
    this._recycled = []

    this.clientId = ''
    this._mutes = muteSet
    this._tracker = tracker

    this.listenTo(theme, 'themeChange', this._onThemeChange)
  }

  addMessage(chat, removeOverLimit = true) {
    if (this._mutes.has(chat.userId)) {
      return null
    }
    if (this.messageKeys.has(chat.key)) {
      return null
    }

    const newCount = this.messages.length + 1
    if (removeOverLimit && newCount > MESSAGE_LIMIT) {
      const removed = this.messages.splice(0, newCount - MESSAGE_LIMIT)
      this._recycle(removed)
    }

    const message = this._recycled.length ? this._recycled.pop() : new Message(this)
    message.bind(chat, this.clientId)
    this.messages.push(message)
    this.messageKeys.add(message.key)
    this.elem.appendChild(message.elem)
    this._refreshWaypoints()
    return message
  }

  muteUser(userId) {
    if (userId === this.clientId) {
      // don't mute me, me
      return
    }
    this._mutes.add(userId)
    this._tracker.onUserMuted()

    const userMessages = []
    const nonUserMessages = []
    for (const message of this.messages) {
      if (message.userId === userId) {
        userMessages.push(message)
      } else {
        nonUserMessages.push(message)
      }
    }

    this._recycle(userMessages)
    this.messages = nonUserMessages
    this._refreshWaypoints()
  }

  trackSaveGif() {
    this._tracker.onSaveGif()
  }

  destroy() {
    for (const message of this.messages) {
      message.unbind()
      message.dispose()
    }
    super.destroy()
  }

  _recycle(messages) {
    for (const message of messages) {
      this.messageKeys.delete(message.key)
      message.elem.parentElement.removeChild(message.elem)
      message.unbind()
    }

    let toRecycle = Math.max(MAX_RECYCLED - this._recycled.length, 0)
    toRecycle = Math.min(toRecycle, messages.length)
    this._recycled = this._recycled.concat(messages.slice(0, toRecycle))
    for (const message of messages.slice(toRecycle, messages.length)) {
      message.dispose()
    }
  }

  _refreshWaypoints() {
    if (!this._waypointTimeout) {
      this._waypointTimeout = setTimeout(() => {
        Waypoint.refreshAll()
        this._waypointTimeout = null
      }, 0)
    }
  }

  _onThemeChange(newTheme) {
    // Re-render identicons based on the new theme to update any inline styles
    for (const message of this.messages) {
      message.refreshIdenticon()
    }
  }
}

export default function createMessageList() {
  return new MessageList(...arguments)
}
