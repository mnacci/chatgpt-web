import express from 'express'
import { RDSClient } from 'ali-rds'
import CryptoJS from 'crypto-js'
import axios from 'axios'
import type { RequestProps } from './types'
import type { ChatMessage } from './chatgpt'
import { chatConfig, chatReplyProcess, currentModel } from './chatgpt'
import { auth } from './middleware/auth'
import { limiter } from './middleware/limiter'
import { isNotEmptyString } from './utils/is'

let sqlDB: RDSClient | undefined
if (process.env.DATASET_MYSQL_USER) {
  sqlDB = new RDSClient({
    host: '118.195.236.91',
    port: 3306,
    user: process.env.DATASET_MYSQL_USER,
    password: process.env.DATASET_MYSQL_PASSWORD,
    database: process.env.DATASET_MYSQL_DATABASE,
    charset: 'utf8mb4',
  })
}

const app = express()
const router = express.Router()

const AESKey = CryptoJS.MD5(process.env.AUTH_SECRET_KEY || '1234567890123456').toString()
// 定义AES解密函数
function decryptData(data) {
  const decrypted = CryptoJS.AES.decrypt(data, AESKey, {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.Pkcs7,
  })
  return decrypted.toString(CryptoJS.enc.Utf8)
}

// 定义中间件函数
function myMiddleware(req, res, next) {
  // 如果加密数据或密钥为空，则返回错误响应
  if (!req.headers.referer.includes('mashaojie.cn') && !req.headers.referer.includes('localhost') && !req.headers.referer.includes('192.168.'))
    return res.status(401).send('Unauthorized')

  if (req.url.includes('/chat-process'))
    req.body = JSON.parse(decryptData(req.body.queryData))

  next() // 调用next()函数将控制权交给下一个中间件或路由处理函数
}

app.use(express.static('public'))
app.use(express.json())

// 注册中间件函数
app.use(myMiddleware)

app.all('*', (_, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', 'authorization, Content-Type')
  res.header('Access-Control-Allow-Methods', '*')
  next()
})

router.post('/chat-process', [auth, limiter], async (req, res) => {
  res.setHeader('Content-type', 'application/octet-stream')

  let myChat: ChatMessage | undefined
  let { prompt, options = {}, systemMessage, temperature, device, username } = req.body as RequestProps

  const dbRecord: any = { prompt, device, username }
  try {
    prompt = prompt.trim()

    if (prompt) {
      try {
        if (sqlDB) {
          const dbresult = await sqlDB.insert('chatweb', dbRecord)
          dbRecord.id = dbresult.insertId
        }
      }
      catch (error) {
        console.error(error)
      }
      let firstChunk = true
      await chatReplyProcess({
        message: prompt,
        lastContext: options,
        process: (chat: ChatMessage) => {
          res.write(firstChunk ? JSON.stringify(chat) : `\n${JSON.stringify(chat)}`)
          firstChunk = false

          myChat = chat
        },
        systemMessage,
        temperature,
      })
    }
    else {
      console.error('请输入您的会话内容')
      res.write('请输入您的会话内容')
    }
  }
  catch (error) {
    res.write(JSON.stringify(error))
  }
  finally {
    try {
      if (sqlDB && dbRecord.id) {
        dbRecord.conversation = myChat.text
        dbRecord.conversationId = myChat.id
        dbRecord.finish_reason = myChat.detail.choices[0].finish_reason
        sqlDB.update('chatweb', dbRecord)
      }

      try {
        const response = await axios.post('http://118.195.236.91:3010/api/wxPusher', dbRecord)

        if (response.status !== 200)
          console.error('response --> ', response)
      }
      catch (error) {
        console.error('error.message --> ', error.message)
      }
    }
    catch (error) {
      console.error(error.message)
    }
    myChat = undefined
    res.end()
  }
})

router.post('/config', auth, async (req, res) => {
  try {
    const response = await chatConfig()
    res.send(response)
  }
  catch (error) {
    res.send(error)
  }
})

router.post('/session', async (req, res) => {
  try {
    const AUTH_SECRET_KEY = process.env.AUTH_SECRET_KEY

    const hasAuth = isNotEmptyString(AUTH_SECRET_KEY)
    res.send({ status: 'Success', message: '', data: { auth: hasAuth, model: currentModel() } })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

interface VerifyProps {
  token: string
  username: string
  telephone: string
}
router.post('/verify', async (req, res) => {
  try {
    const { token, username, telephone } = req.body as VerifyProps
    if (!token)
      throw new Error('Secret key is empty')

    if (process.env.AUTH_SECRET_KEY !== token)
      throw new Error('密钥无效 | Secret key is invalid')

    const userList = await sqlDB.select('userinfo', { where: { username, telephone, status: 1 } })
    if (userList.length === 0) {
      await sqlDB.insert('userinfo', { username, telephone, status: 0 })
      throw new Error('用户不存在，请联系管理员')
    }

    res.send({ status: 'Success', message: 'Verify successfully', data: null })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

app.use('', router)
app.use('/api', router)
app.set('trust proxy', 1)

app.listen(3002, () => globalThis.console.log('Server is running on port 3002'))
