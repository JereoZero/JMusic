#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.join(__dirname, '..')

const VERSION_FILES = [
  {
    path: 'package.json',
    pattern: /"version":\s*"[\d.]+"/g,
    replacement: (v) => `"version": "${v}"`
  },
  {
    path: 'src-tauri/tauri.conf.json',
    pattern: /"version":\s*"[\d.]+"/g,
    replacement: (v) => `"version": "${v}"`
  },
  {
    path: 'src-tauri/Cargo.toml',
    pattern: /^version\s*=\s*"[\d.]+"/m,
    replacement: (v) => `version = "${v}"`
  },
  {
    path: 'src/config/index.ts',
    pattern: /version:\s*'[\d.]+'/g,
    replacement: (v) => `version: '${v}'`
  }
]

function getCurrentVersion() {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')
  )
  return packageJson.version
}

function parseVersion(version) {
  const parts = version.split('.').map(Number)
  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0
  }
}

function bumpVersion(currentVersion, type) {
  const v = parseVersion(currentVersion)
  
  switch (type) {
    case 'major':
      return `${v.major + 1}.0.0`
    case 'minor':
      return `${v.major}.${v.minor + 1}.0`
    case 'patch':
      return `${v.major}.${v.minor}.${v.patch + 1}`
    default:
      if (/^\d+\.\d+\.\d+$/.test(type)) {
        return type
      }
      throw new Error(`Invalid version type: ${type}`)
  }
}

function updateVersionFiles(newVersion) {
  VERSION_FILES.forEach(({ path: filePath, pattern, replacement }) => {
    const fullPath = path.join(PROJECT_ROOT, filePath)
    
    if (!fs.existsSync(fullPath)) {
      console.log(`⚠️  File not found: ${filePath}`)
      return
    }
    
    let content = fs.readFileSync(fullPath, 'utf8')
    const newContent = content.replace(pattern, replacement(newVersion))
    
    if (content === newContent) {
      console.log(`⚠️  No version pattern found in: ${filePath}`)
      return
    }
    
    fs.writeFileSync(fullPath, newContent)
    console.log(`✅ Updated: ${filePath}`)
  })
}

function showHelp() {
  console.log(`
Jlocal Version Manager

Usage:
  node scripts/version.js <command> [options]

Commands:
  current         Show current version
  patch           Bump patch version (0.0.x)
  minor           Bump minor version (0.x.0)
  major           Bump major version (x.0.0)
  <version>       Set specific version (e.g., 1.0.0)

Examples:
  node scripts/version.js current
  node scripts/version.js patch
  node scripts/version.js minor
  node scripts/version.js 1.0.0
`)
}

function main() {
  const args = process.argv.slice(2)
  
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    showHelp()
    process.exit(0)
  }
  
  const command = args[0]
  const currentVersion = getCurrentVersion()
  
  if (command === 'current') {
    console.log(`Current version: ${currentVersion}`)
    process.exit(0)
  }
  
  let newVersion
  
  try {
    newVersion = bumpVersion(currentVersion, command)
  } catch (error) {
    console.error(`❌ ${error.message}`)
    showHelp()
    process.exit(1)
  }
  
  console.log(`\n📦 Bumping version: ${currentVersion} → ${newVersion}\n`)
  
  updateVersionFiles(newVersion)
  
  console.log(`\n✨ Version updated to ${newVersion}`)
  console.log(`\nNext steps:`)
  console.log(`  1. Review the changes`)
  console.log(`  2. git add .`)
  console.log(`  3. git commit -m "chore: bump version to ${newVersion}"`)
  console.log(`  4. git tag v${newVersion}`)
}

main()
