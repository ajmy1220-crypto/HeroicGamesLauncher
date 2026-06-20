import { makeHandlerInvoker } from '../ipc'

// Helmsman（AI 編排層）。channel 只收 { appName, runner[, action] }，context 由後端權威組。
export const helmsmanDiagnose = makeHandlerInvoker('helmsmanDiagnose')
export const helmsmanApplyAction = makeHandlerInvoker('helmsmanApplyAction')
export const helmsmanAdvise = makeHandlerInvoker('helmsmanAdvise')
