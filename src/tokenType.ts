// @ts-ignore
import { TokenType, keywordTypes, tokTypes, TokContext } from 'acorn'
import { AcornTypeScript } from './types'

const startsExpr = true

// Succinct definitions of keyword token types

function kwLike(_name, options: any = {}) {
  return new TokenType('name', options)
}

const acornTypeScriptMap = new WeakMap()

export function generateAcornTypeScript(_acorn: any): AcornTypeScript {
  const acorn = _acorn.Parser.acorn || _acorn
  let acornTypeScript = acornTypeScriptMap.get(acorn)
  if (!acornTypeScript) {
    const tsKwTokenType = generateTsKwTokenType()
    const tsTokenType = generateTsTokenType()
    const tsTokenContext = generateTsTokenContext()
    const tsKeywordsRegExp = new RegExp(
      `^(?:${Object.keys(tsKwTokenType).join('|')})$`
    )

    tsTokenType.jsxTagStart.updateContext = function() {
      this.context.push(tsTokenContext.tc_expr) // treat as beginning of
      // JSX expression
      this.context.push(tsTokenContext.tc_oTag) // start opening tag context
      this.exprAllowed = false
    }

    tsTokenType.jsxTagEnd.updateContext = function(prevType) {
      let out = this.context.pop()
      if (out === tsTokenContext.tc_oTag && prevType === tokTypes.slash || out === tsTokenContext.tc_cTag) {
        this.context.pop()
        this.exprAllowed = this.curContext() === tsTokenContext.tc_expr
      } else {
        this.exprAllowed = true
      }
    }

    function tokenIsLiteralPropertyName(token: TokenType): boolean {
      return [
        ...[tokTypes.name, tokTypes.string, tokTypes.num],
        ...Object.values(keywordTypes),
        ...Object.values(tsKwTokenType)
      ].includes(token)
    }

    function tokenIsKeywordOrIdentifier(token: TokenType): boolean {
      return [
        ...[tokTypes.name],
        ...Object.values(keywordTypes),
        ...Object.values(tsKwTokenType)
      ].includes(token)
    }

    function tokenIsIdentifier(token: TokenType): boolean {
      return [...Object.values(tsKwTokenType), tokTypes.name].includes(token)
    }

    function tokenIsTSDeclarationStart(token: TokenType): boolean {
      return [
        tsKwTokenType.abstract,
        tsKwTokenType.declare,
        tsKwTokenType.enum,
        tsKwTokenType.module,
        tsKwTokenType.namespace,
        tsKwTokenType.interface,
        tsKwTokenType.type
      ].includes(token)
    }

    function tokenIsTSTypeOperator(token: TokenType): boolean {
      return [
        tsKwTokenType.keyof,
        tsKwTokenType.readonly,
        tsKwTokenType.unique
      ].includes(token)
    }

    function tokenIsTemplate(token: TokenType): boolean {
      return token === tokTypes.invalidTemplate
    }

    acornTypeScript = {
      tokTypes: {
        ...tsKwTokenType,
        ...tsTokenType
      },
      tokContexts: {
        ...tsTokenContext
      },
      keywordsRegExp: tsKeywordsRegExp,
      tokenIsLiteralPropertyName,
      tokenIsKeywordOrIdentifier,
      tokenIsIdentifier,
      tokenIsTSDeclarationStart,
      tokenIsTSTypeOperator,
      tokenIsTemplate
    }
  }

  return acornTypeScript
}

function generateTsTokenContext() {
  return {
    tc_oTag: new TokContext('<tag', false, false),
    tc_cTag: new TokContext('</tag', false, false),
    tc_expr: new TokContext('<tag>...</tag>', true, true)
  }
}

function generateTsTokenType() {
  return {
    at: new TokenType('@'),
    jsxName: new TokenType('jsxName'),
    jsxText: new TokenType('jsxText', { beforeExpr: true }),
    jsxTagStart: new TokenType('jsxTagStart', { startsExpr: true }),
    jsxTagEnd: new TokenType('jsxTagEnd')
  }
}

function generateTsKwTokenType() {
  return {
    as: kwLike('name', { startsExpr }),
    assert: kwLike('assert', { startsExpr }),
    async: kwLike('async', { startsExpr }),
    await: kwLike('await', { startsExpr }),
    from: kwLike('from', { startsExpr }),
    get: kwLike('get', { startsExpr }),
    let: kwLike('let', { startsExpr }),
    meta: kwLike('meta', { startsExpr }),
    of: kwLike('of', { startsExpr }),
    sent: kwLike('sent', { startsExpr }),
    set: kwLike('set', { startsExpr }),
    static: kwLike('static', { startsExpr }),
    yield: kwLike('yield', { startsExpr }),

    asserts: kwLike('asserts', { startsExpr }),
    checks: kwLike('checks', { startsExpr }),
    exports: kwLike('exports', { startsExpr }),
    global: kwLike('global', { startsExpr }),
    implements: kwLike('implements', { startsExpr }),
    intrinsic: kwLike('intrinsic', { startsExpr }),
    infer: kwLike('infer', { startsExpr }),
    is: kwLike('is', { startsExpr }),
    mixins: kwLike('mixins', { startsExpr }),
    proto: kwLike('proto', { startsExpr }),
    require: kwLike('require', { startsExpr }),
    keyof: kwLike('keyof', { startsExpr }),
    readonly: kwLike('readonly', { startsExpr }),
    unique: kwLike('unique', { startsExpr }),
    abstract: kwLike('abstract', { startsExpr }),
    declare: kwLike('declare', { startsExpr }),
    enum: kwLike('enum', { startsExpr }),
    module: kwLike('module', { startsExpr }),
    namespace: kwLike('namespace', { startsExpr }),
    interface: kwLike('interface', { startsExpr }),
    type: kwLike('type', { startsExpr }),
    opaque: kwLike('opaque', { startsExpr })
  }
}


