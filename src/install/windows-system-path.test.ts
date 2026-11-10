import { expect, test } from 'bun:test'
import { windowsJoin, windowsSystemTool } from './windows-system-path'

test('a Windows tool is named under SystemRoot, else C:\\Windows, never by bare name', () => {
  expect(windowsSystemTool({ envVars: { SystemRoot: 'D:\\Win' } }, 'System32\\schtasks.exe')).toBe('D:\\Win\\System32\\schtasks.exe')
  expect(windowsSystemTool({ envVars: { SystemRoot: 'D:\\Win\\' } }, 'System32\\schtasks.exe')).toBe('D:\\Win\\System32\\schtasks.exe')
  expect(windowsSystemTool({ envVars: {} }, 'System32\\schtasks.exe')).toBe('C:\\Windows\\System32\\schtasks.exe')
  expect(windowsSystemTool({ envVars: { SystemRoot: '' } }, 'System32\\schtasks.exe')).toBe('C:\\Windows\\System32\\schtasks.exe')
  expect(windowsSystemTool({}, 'System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
})

test('a SystemRoot that is not an absolute path falls back to C:\\Windows', () => {
  const tool = (root: string): string => windowsSystemTool({ envVars: { SystemRoot: root } }, 'System32\\schtasks.exe')
  for (const root of ['.', 'Windows', '..\\Windows', 'C:', 'C:Windows', 'C:\\Windows\\..\\repo', 'C:/Windows/../repo', '\\Windows', '/mnt/c/Windows']) {
    expect(tool(root)).toBe('C:\\Windows\\System32\\schtasks.exe')
  }
  expect(tool('\\\\server\\share\\Windows')).toBe('\\\\server\\share\\Windows\\System32\\schtasks.exe')
  expect(tool('d:/Win')).toBe('d:/Win\\System32\\schtasks.exe')
})

test('windowsJoin joins with backslashes and drops trailing separators', () => {
  expect(windowsJoin('C:\\Users\\me/', 'AppData', 'Local')).toBe('C:\\Users\\me\\AppData\\Local')
})
