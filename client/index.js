import createAbout from './about'
import analytics from './analytics'
import createDropdown from './dropdown'
import getFingerprint from './fingerprint'
import io from './io'
import NotificationCounter from './notification-counter'
import * as room from './room'
import StoredSet from './stored-set'
import theme from './theme'
import transitionEvent from './transition-event'

const app = {
  muteSet: new StoredSet('mutes'),
  clientId: null
}

let active = 0
io.on('connect', function() {
  io.emit('fingerprint', getFingerprint())
  io.emit('join', 'jpg')
}).on('disconnect', function() {
  active = 0
  updateActiveUsers()
})

io.on('userid', function(id) {
  app.clientId = id
  if (app.messageList) app.messageList.clientId = id
})

let unreadMessages = 0
io.on('chat', function(chat) {
  const autoScroll = window.pageYOffset + window.innerHeight + 32 > document.body.clientHeight
  const message = messageList.addMessage(chat, autoScroll)
  if (message && autoScroll) {
    message.elem.scrollIntoView()
  }

  if (message && document.hidden) {
    unreadMessages++
    updateNotificationCount()
  }
}).on('active', function(numActive) {
  active = numActive
  updateActiveUsers()
})

function updateActiveUsers() {
  const elem = document.querySelector('#active-users')
  if (active > 0) {
    elem.innerHTML = '' + active
    elem.title = `${active} active users`
  } else {
    elem.innerHTML = '?'
    elem.title = 'not connected'
  }
}

createDropdown(document.querySelector('header .dropdown'), {
  logout: () => {
    console.log('todo')
  },
  unmute: () => {
    muteSet.clear()
    analytics.onUnmute()
  },
  changeTheme: () => {
    const newTheme = theme.isDark() ? 'light' : 'dark'
    theme.setTheme(newTheme)
    analytics.onChangeTheme(newTheme)
  },
  about: () => {
    showAbout()
    analytics.onShowAbout()
  },
})

const updateTheme = newTheme => {
  document.body.classList.toggle('dark', newTheme === 'dark')
  const otherTheme = newTheme === 'light' ? 'dark' : 'light'
  document.querySelector('#change-theme').textContent = `Use ${otherTheme} theme`
}

theme.on('themeChange', updateTheme)
updateTheme(theme.getTheme())

document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('backgrounded', document.hidden)
  if (!document.hidden) {
    unreadMessages = 0
    updateNotificationCount()
  }
})

const notificationCounter = new NotificationCounter()
function updateNotificationCount() {
  if (!unreadMessages) {
    notificationCounter.clear()
  } else {
    notificationCounter.setCount(unreadMessages)
  }
}

function showAbout() {
  const { scrim, container, dialog } = createAbout()
  document.body.appendChild(scrim)
  document.body.appendChild(container)

  setTimeout(() => {
    scrim.classList.remove('entering')
    dialog.classList.remove('entering')
  }, 15)

  const clickListener = e => {
    if (e.target !== container) return

    container.removeEventListener('click', clickListener)
    // remove the dialog
    scrim.classList.add('will-leave')
    dialog.classList.add('will-leave')

    setTimeout(() => {
      scrim.classList.add('leaving')
      dialog.classList.add('leaving')

      scrim.addEventListener(transitionEvent, () => document.body.removeChild(scrim))
      dialog.addEventListener(transitionEvent, () => document.body.removeChild(container))
    }, 15)
  }
  container.addEventListener('click', clickListener)
}
