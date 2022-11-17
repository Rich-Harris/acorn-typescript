// @ts-nocheck
import {
  tokTypes,
  keywordTypes,
  isNewLine,
  isIdentifierChar,
  Position,
  lineBreak
} from 'acorn'
import * as charCodes from 'charcodes'
import type { Node, TokenType, Parser as AcornParser } from 'acorn'
import { TypeScriptError } from './error'
import { tsKeywordsRegExp, tsTokenType, jsxTokenType } from './tokenType'
import { LookaheadState, ModifierBase, TsModifier } from './types'
import {
  BIND_LEXICAL,
  BIND_TS_CONST_ENUM,
  BIND_TS_ENUM,
  BIND_TS_INTERFACE,
  BIND_TS_NAMESPACE,
  BIND_TS_TYPE,
  SCOPE_OTHER, SCOPE_SIMPLE_CATCH,
  SCOPE_TS_MODULE
} from './scopeflags'
import {
  ArrayPattern, Class,
  Declaration, Expression,
  Identifier,
  ObjectPattern, Pattern,
  RestElement
} from 'estree'
import { skipWhiteSpaceToLineBreak } from './whitespace'
import {
  checkKeyName,
  DestructuringErrors,
  isPrivateNameConflicted
} from './parseutil'

export const skipWhiteSpace = /(?:\s|\/\/.*|\/\*[^]*?\*\/)*/g

function assert(x: boolean): void {
  if (!x) {
    throw new Error('Assert fail')
  }
}

const FUNC_STATEMENT = 1, FUNC_HANGING_STATEMENT = 2, FUNC_NULLABLE_ID = 4

function nonNull<T>(x?: T | null): T {
  if (x == null) {
    throw new Error(`Unexpected ${x} value.`)
  }
  return x
}

// Doesn't handle "void" or "null" because those are keywords, not identifiers.
// It also doesn't handle "intrinsic", since usually it's not a keyword.
function keywordTypeFromName(
  value: string
): Node | typeof undefined {
  switch (value) {
    case 'any':
      return 'TSAnyKeyword'
    case 'boolean':
      return 'TSBooleanKeyword'
    case 'bigint':
      return 'TSBigIntKeyword'
    case 'never':
      return 'TSNeverKeyword'
    case 'number':
      return 'TSNumberKeyword'
    case 'object':
      return 'TSObjectKeyword'
    case 'string':
      return 'TSStringKeyword'
    case 'symbol':
      return 'TSSymbolKeyword'
    case 'undefined':
      return 'TSUndefinedKeyword'
    case 'unknown':
      return 'TSUnknownKeyword'
    default:
      return undefined
  }
}

function tokenIsLiteralPropertyName(token: TokenType): boolean {
  return [...Object.values(keywordTypes), ...Object.values(tsTokenType)].includes(token)
}

function tokenIsKeywordOrIdentifier(token: TokenType): boolean {
  return [...Object.values(keywordTypes), ...Object.values(tsTokenType)].includes(token)
}

function tokenIsIdentifier(token: TokenType): boolean {
  return [...Object.values(tsTokenType), tokTypes.name].includes(token)
}

function tokenIsTSDeclarationStart(token: TokenType): boolean {
  return [
    tsTokenType.abstract,
    tsTokenType.declare,
    tsTokenType.enum,
    tsTokenType.module,
    tsTokenType.namespace,
    tsTokenType.interface,
    tsTokenType.type
  ].includes(token)
}

export function tokenIsTSTypeOperator(token: TokenType): boolean {
  return [
    tsTokenType.keyof,
    tsTokenType.readonly,
    tsTokenType.unique
  ].includes(token)
}

export default function tsPlugin(options?: {
  // default false
  dts?: boolean
  // default false
  disallowAmbiguousJSXLike?: boolean
}) {
  const { dts = false, disallowAmbiguousJSXLike = false } = options || {}
  return function(Parser: typeof AcornParser) {
    return class TypeScriptParser extends Parser {
      isLookahead: boolean = false
      isAmbientContext: boolean = false
      inAbstractClass: boolean = false
      inType: boolean = false
      inDisallowConditionalTypesContext: boolean = false

      // ensure that inside types, we bypass the jsx parser plugin
      getTokenFromCode(code: number): void {
        if (this.inType) {
          if (code === charCodes.greaterThan) {
            return this.finishOp(tokTypes.relational, 1)
          }
          if (code === charCodes.lessThan) {
            return this.finishOp(tokTypes.relational, 1)
          }
        }
        return super.getTokenFromCode(code)
      }

      // used after we have finished parsing types
      reScan_lt_gt() {
        const { type } = this
        if (type === tokTypes.relational) {
          this.pos -= 1
          this.readToken_lt_gt(this.fullCharCodeAtPos())
        }
      }

      reScan_lt() {
        const { type } = this
        if (type === tokTypes.bitShift) {
          this.pos -= 2
          this.finishOp(tokTypes.relational, 1)
          return tokTypes.relational
        }
        return type
      }

      resetEndLocation(
        node: Node,
        endLoc: Position = this.lastTokEndLoc
      ): void {
        node.end = endLoc.index
        node.loc.end = endLoc
        if (this.options.ranges) node.range[1] = endLoc.index
      }

      startNodeAtNode(type: Node): Node {
        return super.startNodeAt(type.start, type.loc.start)
      }

      nextTokenStart(): number {
        return this.nextTokenStartSince(this.pos)
      }

      tsIsIdentifier(): boolean {
        // TODO: actually a bit more complex in TypeScript, but shouldn't matter.
        // See https://github.com/Microsoft/TypeScript/issues/15008
        return tokenIsIdentifier(this.type)
      }

      tsInNoContext<T>(cb: () => T): T {
        const oldContext = this.context
        this.context = [oldContext[0]]
        try {
          return cb()
        } finally {
          this.context = oldContext
        }
      }

      tsTryParseTypeAnnotation(): Node | undefined | null {
        return this.match(tokTypes.colon) ? this.tsParseTypeAnnotation() : undefined
      }

      isUnparsedContextual(nameStart: number, name: string): boolean {
        const nameEnd = nameStart + name.length
        if (this.input.slice(nameStart, nameEnd) === name) {
          const nextCh = this.input.charCodeAt(nameEnd)
          return !(
            isIdentifierChar(nextCh) ||
            // check if `nextCh is between 0xd800 - 0xdbff,
            // if `nextCh` is NaN, `NaN & 0xfc00` is 0, the function
            // returns true
            (nextCh & 0xfc00) === 0xd800
          )
        }
        return false
      }

      isAbstractConstructorSignature(): boolean {
        return (
          this.ts_isContextual(tsTokenType.abstract) && this.lookahead().type === tokTypes._new
        )
      }

      nextTokenStartSince(pos: number): number {
        skipWhiteSpace.lastIndex = pos
        return skipWhiteSpace.test(this.input) ? skipWhiteSpace.lastIndex : pos
      }

      lookaheadCharCode(): number {
        return this.input.charCodeAt(this.nextTokenStart())
      }

      createLookaheadState() {
        this.value = null
        this.context = [this.curContext()]
      }

      getCurLookaheadState(): LookaheadState {
        return {
          pos: this.pos,
          value: this.value,
          type: this.type,
          start: this.start,
          end: this.end,
          context: this.context,
          startLoc: this.startLoc,
          lastTokEndLoc: this.lastTokEndLoc,
          curLine: this.curLine,
          lineStart: this.lineStart,
          curPosition: this.curPosition
        }
      }

      setLookaheadState(state: LookaheadState) {
        this.pos = state.pos
        this.value = state.value
        this.type = state.type
        this.start = state.start
        this.end = state.end
        this.context = state.context
        this.startLoc = state.startLoc
        this.lastTokEndLoc = state.lastTokEndLoc
        this.curLine = state.curLine
        this.lineStart = state.lineStart
        this.curPosition = state.curPosition
      }

      // Utilities

      tsLookAhead<T>(f: () => T): T {
        const state = this.getCurLookaheadState()
        const res = f()
        this.setLookaheadState(state)
        return res
      }

      lookahead(): LookaheadState {
        const oldState = this.getCurLookaheadState()

        this.createLookaheadState()
        this.isLookahead = true

        this.nextToken()

        this.isLookahead = false

        const curState = this.getCurLookaheadState()
        this.setLookaheadState(oldState)
        return curState
      }

      readWord() {
        let word = this.readWord1()
        let type = tokTypes.name

        if (this.keywords.test(word)) {
          type = keywordTypes[word]
        } else if (new RegExp(tsKeywordsRegExp).test(word)) {
          type = tsTokenType[word]
        }

        return this.finishToken(type, word)
      }

      skipBlockComment() {
        let startLoc
        if (!this.isLookahead) startLoc = this.options.onComment && this.curPosition()
        let start = this.pos, end = this.input.indexOf('*/', this.pos += 2)
        if (end === -1) this.raise(this.pos - 2, 'Unterminated comment')
        this.pos = end + 2
        if (this.options.locations) {
          for (let nextBreak, pos = start; (nextBreak = nextLineBreak(this.input, pos, this.pos)) > -1;) {
            ++this.curLine
            pos = this.lineStart = nextBreak
          }
        }

        if (this.isLookahead) return

        if (this.options.onComment)
          this.options.onComment(true, this.input.slice(start + 2, end), start, this.pos,
            startLoc, this.curPosition())
      }

      skipLineComment(startSkip) {
        let start = this.pos
        let startLoc
        if (!this.isLookahead) startLoc = this.options.onComment && this.curPosition()
        let ch = this.input.charCodeAt(this.pos += startSkip)
        while (this.pos < this.input.length && !isNewLine(ch)) {
          ch = this.input.charCodeAt(++this.pos)
        }

        if (this.isLookahead) return

        if (this.options.onComment)
          this.options.onComment(false, this.input.slice(start + startSkip, this.pos), start, this.pos,
            startLoc, this.curPosition())
      }

      finishToken(type, val) {
        this.end = this.pos
        if (this.options.locations) this.endLoc = this.curPosition()
        let prevType = this.type
        this.type = type
        this.value = val

        if (!this.isLookahead) {
          this.updateContext(prevType)
        }
      }

      nextToken() {
        let curContext = this.curContext()
        if (!curContext || !curContext.preserveSpace) this.skipSpace()

        this.start = this.pos
        if (this.options.locations && !this.isLookahead) {
          this.startLoc = this.curPosition()
        }
        if (this.pos >= this.input.length) {
          return this.finishToken(tokTypes.eof)
        }

        if (curContext.override) {
          return curContext.override(this)
        } else {
          this.readToken(this.fullCharCodeAtPos())
        }
      }

      resetStartLocation(node: Node, start: number, startLoc: Position): void {
        node.start = start
        node.loc.start = startLoc
        if (this.options.ranges) node.range[0] = start
      }

      isLineTerminator(): boolean {
        return this.eat(tokTypes.semi) || super.canInsertSemicolon()
      }

      hasFollowingLineBreak(): boolean {
        skipWhiteSpaceToLineBreak.lastIndex = this.end
        return skipWhiteSpaceToLineBreak.test(this.input)
      }

      addExtra(
        node: Partial<Node>,
        key: string,
        value: any,
        enumerable: boolean = true
      ): void {
        if (!node) return

        const extra = (node.extra = node.extra || {})
        if (enumerable) {
          extra[key] = value
        } else {
          Object.defineProperty(extra, key, { enumerable, value })
        }
      }

      /**
       * Test if current token is a literal property name
       * https://tc39.es/ecma262/#prod-LiteralPropertyName
       * LiteralPropertyName:
       *   IdentifierName
       *   StringLiteral
       *   NumericLiteral
       *   BigIntLiteral
       */
      isLiteralPropertyName(): boolean {
        return tokenIsLiteralPropertyName(this.type)
      }

      hasPrecedingLineBreak(): boolean {
        return lineBreak.test(
          this.input.slice(this.lastTokEnd, this.start)
        )
      }

      createIdentifier(
        node: Omit<Identifier, 'type'>,
        name: string
      ): Identifier {
        node.name = name

        return this.finishNode(node, 'Identifier')
      }

      /**
       * Reset the start location of node to the start location of locationNode
       */
      resetStartLocationFromNode(node: Node, locationNode: Node): void {
        this.resetStartLocation(node, locationNode.start, locationNode.loc.start)
      }

      // This is used in flow and typescript plugin
      // Determine whether a parameter is a this param
      isThisParam(
        param: Pattern | Identifier
      ): boolean {
        return param.type === 'Identifier' && param.name === 'this'
      }

      isLookaheadContextual(name: string): boolean {
        const next = this.nextTokenStart()
        return this.isUnparsedContextual(next, name)
      }

      /**
       * ts isContextual
       * @param {TokenType} token
       * @returns {boolean}
       * */
      ts_isContextual(token: TokenType): boolean {
        return this.type === token && !this.containsEsc
      }

      tsIsStartOfMappedType(): boolean {
        this.next()
        if (this.eat(tokTypes.plusMin)) {
          return this.ts_isContextual(tsTokenType.readonly)
        }
        if (this.ts_isContextual(tsTokenType.readonly)) {
          this.next()
        }
        if (!this.match(tokTypes.bracketL)) {
          return false
        }
        this.next()
        if (!this.tsIsIdentifier()) {
          return false
        }
        this.next()
        return this.match(tokTypes._in)
      }

      tsInDisallowConditionalTypesContext<T>(cb: () => T): T {
        const oldInDisallowConditionalTypesContext =
          this.inDisallowConditionalTypesContext
        this.inDisallowConditionalTypesContext = true
        try {
          return cb()
        } finally {
          this.inDisallowConditionalTypesContext =
            oldInDisallowConditionalTypesContext
        }
      }

      /**
       * ts type isContextual
       * @param {TokenType} type
       * @param {TokenType} token
       * @returns {boolean}
       * */
      ts_type_isContextual(type: TokenType, token: TokenType): boolean {
        return type === token && !this.containsEsc
      }

      tsTryParseType(): Node | undefined | null {
        return this.tsEatThenParseType(tokTypes.colon)
      }

      /**
       * Whether current token matches given type
       *
       * @param {TokenType} type
       * @returns {boolean}
       * @memberof Tokenizer
       */
      match(type: TokenType): boolean {
        return this.type === type
      }

      eatContextual(name: string) {
        if (tsKeywordsRegExp.test(name)) {
          if (this.ts_isContextual(tsTokenType[name])) {
            this.next()
            return true
          }
          return false
        } else {
          super.eatContextual(name)
        }
      }

      tsIsExternalModuleReference(): boolean {
        return (
          this.ts_isContextual(tsTokenType.require) &&
          this.lookaheadCharCode() === charCodes.leftParenthesis
        )
      }

      tsParseExternalModuleReference() {
        const node = this.startNode()
        this.expectContextual('require')
        super.expect(tokTypes.parenL)
        if (!this.match(tokTypes.string)) {
          this.unexpected()
        }
        // For compatibility to estree we cannot call parseLiteral directly here
        node.expression = super.parseExprAtom()
        this.expect(tokTypes.parenR)
        return this.finishNode(node, 'TSExternalModuleReference')
      }

      tsParseEntityName(allowReservedWords: boolean = true): Node {
        let entity = super.parseIdent(allowReservedWords)
        while (this.eat(tokTypes.dot)) {
          const node = this.startNodeAtNode(entity)
          node.left = entity
          node.right = super.parseIdent(allowReservedWords)
          entity = this.finishNode(node, 'TSQualifiedName')
        }
        return entity
      }

      tsParseEnumMember(): Node {
        const node = this.startNode()
        // Computed property names are grammar errors in an enum, so accept just string literal or identifier.
        node.id = this.match(tokTypes.string)
          ? super.parseLiteral(this.value)
          : this.parseIdent(/* liberal */ true)
        if (this.eat(tokTypes.eq)) {
          node.initializer = super.parseMaybeAssign()
        }
        return this.finishNode(node, 'TSEnumMember')
      }

      tsParseEnumDeclaration(
        node: Node,
        properties: {
          const?: true;
          declare?: true;
        } = {}
      ): Node {
        if (properties.const) node.const = true
        if (properties.declare) node.declare = true
        this.expectContextual('enum')
        node.id = this.parseIdent()
        super.checkLValSimple(node.id)

        this.expect(tokTypes.braceL)
        node.members = this.tsParseDelimitedList(
          'EnumMembers',
          this.tsParseEnumMember.bind(this)
        )
        this.expect(tokTypes.braceR)
        return this.finishNode(node, 'TSEnumDeclaration')
      }

      tsParseModuleBlock(): Node {
        const node = this.startNode()
        super.enterScope(SCOPE_OTHER)

        this.expect(tokTypes.braceL)
        // Inside of a module block is considered "top-level", meaning it can have imports and exports.
        node.body = []
        while (this.type !== tokTypes.braceR) {
          let stmt = super.parseStatement(null, true)
          node.body.push(stmt)
        }
        super.exitScope()
        return this.finishNode(node, 'TSModuleBlock')
      }

      tsParseAmbientExternalModuleDeclaration(
        node: Node
      ): Node {
        if (this.ts_isContextual(tsTokenType.global)) {
          node.global = true
          node.id = super.parseIdent()
        } else if (this.match(tokTypes.string)) {
          node.id = super.parseLiteral(this.value)
        } else {
          this.unexpected()
        }
        if (this.match(tokTypes.braceL)) {
          super.enterScope(SCOPE_TS_MODULE)
          node.body = this.tsParseModuleBlock()
          super.exitScope()
        } else {
          super.semicolon()
        }

        return this.finishNode(node, 'TSModuleDeclaration')
      }

      tsTryParseDeclare(nany: any): Declaration | undefined | null {
        if (this.isLineTerminator()) {
          return
        }
        let starttype = this.type
        let kind: 'let' | null

        if (this.ts_isContextual(tsTokenType.let)) {
          starttype = tokTypes._var
          kind = 'let' as const
        }

        // @ts-expect-error refine typings
        return this.tsInAmbientContext(() => {
          if (starttype === tokTypes._function) {
            nany.declare = true
            return super.parseFunctionStatement(
              nany,
              /* async */ false,
              /* declarationPosition */ true
            )
          }

          if (starttype === tokTypes._class) {
            // While this is also set by tsParseExpressionStatement, we need to set it
            // before parsing the class declaration to know how to register it in the scope.
            nany.declare = true
            return this.parseClass(nany, true)
          }

          if (starttype === tsTokenType.enum) {
            return this.tsParseEnumDeclaration(nany, { declare: true })
          }

          if (starttype === tsTokenType.global) {
            return this.tsParseAmbientExternalModuleDeclaration(nany)
          }

          if (starttype === tokTypes._const || starttype === tokTypes._var) {
            if (!this.match(tokTypes._const) || !this.isLookaheadContextual('enum')) {
              nany.declare = true
              return this.parseVarStatement(nany, kind || this.value)
            }

            // `const enum = 0;` not allowed because "enum" is a strict mode reserved word.
            this.expect(tokTypes._const)
            return this.tsParseEnumDeclaration(nany, {
              const: true,
              declare: true
            })
          }

          if (starttype === tsTokenType.interface) {
            const result = this.tsParseInterfaceDeclaration(nany, {
              declare: true
            })
            if (result) return result
          }

          if (tokenIsIdentifier(starttype)) {
            return this.tsParseDeclaration(
              nany,
              this.state.value,
              /* next */ true
            )
          }
        })
      }

      tsIsListTerminator(kind: any): boolean {
        switch (kind) {
          case 'EnumMembers':
          case 'TypeMembers':
            return this.match(tokTypes.braceR)
          case 'HeritageClauseElement':
            return this.match(tokTypes.braceL)
          case 'TupleElementTypes':
            return this.match(tokTypes.bracketR)
          case 'TypeParametersOrArguments':
            return this.match(tokTypes.relational)
        }

        throw new Error('Unreachable')
      }

      /**
       * If !expectSuccess, returns undefined instead of failing to parse.
       * If expectSuccess, parseElement should always return a defined value.
       */
      tsParseDelimitedListWorker<T extends Node>(
        kind: any,
        parseElement: () => T | undefined | null,
        expectSuccess: boolean,
        refTrailingCommaPos?: {
          value: number;
        }
      ): T[] | undefined | null {
        const result = []
        let trailingCommaPos = -1

        for (; ;) {
          if (this.tsIsListTerminator(kind)) {
            break
          }
          trailingCommaPos = -1

          const element = parseElement()
          if (element == null) {
            return undefined
          }
          result.push(element)

          if (this.eat(tokTypes.comma)) {
            trailingCommaPos = this.lastTokStart
            continue
          }

          if (this.tsIsListTerminator(kind)) {
            break
          }

          if (expectSuccess) {
            // This will fail with an error about a missing comma
            this.expect(tokTypes.comma)
          }
          return undefined
        }

        if (refTrailingCommaPos) {
          refTrailingCommaPos.value = trailingCommaPos
        }

        return result
      }

      tsParseDelimitedList<T extends Node>(
        kind: any,
        parseElement: () => T,
        refTrailingCommaPos?: {
          value: number;
        }
      ): T[] {
        return nonNull(
          this.tsParseDelimitedListWorker(
            kind,
            parseElement,
            /* expectSuccess */ true,
            refTrailingCommaPos
          )
        )
      }

      tsParseBracketedList<T extends Node>(
        kind: any,
        parseElement: () => T,
        bracket: boolean,
        skipFirstToken: boolean,
        refTrailingCommaPos?: {
          value: number;
        }
      ): T[] {
        if (!skipFirstToken) {
          if (bracket) {
            this.expect(tokTypes.bracketL)
          } else {
            this.expect(tokTypes.relational)
          }
        }

        const result = this.tsParseDelimitedList(
          kind,
          parseElement,
          refTrailingCommaPos
        )

        if (bracket) {
          this.expect(tokTypes.bracketR)
        } else {
          this.expect(tokTypes.relational)
        }

        return result
      }

      tsParseTypeParameterName(): Identifier | string {
        const typeName = this.parseIdent()
        return typeName.name
      }

      tsEatThenParseType(token: TokenType): Node | typeof undefined {
        return !this.match(token) ? undefined : this.tsNextThenParseType()
      }

      tsExpectThenParseType(token: TokenType): Node {
        return this.tsDoThenParseType(() => this.expect(token))
      }

      tsNextThenParseType(): Node {
        return this.tsDoThenParseType(() => this.next())
      }

      tsDoThenParseType(cb: () => void): Node {
        return this.tsInType(() => {
          cb()
          return this.tsParseType()
        })
      }

      tsSkipParameterStart(): boolean {
        if (tokenIsIdentifier(this.type) || this.match(tokTypes._this)) {
          this.next()
          return true
        }

        if (this.match(tokTypes.braceL)) {
          // Return true if we can parse an object pattern without errors
          try {
            super.parseObj(true)
            return true
          } catch {
            return false
          }
        }

        if (this.match(tokTypes.bracketL)) {
          this.next()
          try {
            super.parseBindingList(
              tokTypes.bracketR,
              true,
              true
            )
            return true
          } catch {
            return false
          }
        }

        return false
      }

      tsIsUnambiguouslyStartOfFunctionType(): boolean {
        this.next()
        if (this.match(tokTypes.parenR) || this.match(tokTypes.ellipsis)) {
          // ( )
          // ( ...
          return true
        }
        if (this.tsSkipParameterStart()) {
          if (
            this.match(tokTypes.colon) ||
            this.match(tokTypes.comma) ||
            this.match(tokTypes.question) ||
            this.match(tokTypes.eq)
          ) {
            // ( xxx :
            // ( xxx ,
            // ( xxx ?
            // ( xxx =
            return true
          }
          if (this.match(tokTypes.parenR)) {
            this.next()
            if (this.match(tokTypes.arrow)) {
              // ( xxx ) =>
              return true
            }
          }
        }
        return false
      }

      tsIsStartOfFunctionType() {
        if (this.match(tokTypes.relational)) {
          return true
        }
        return (
          this.match(tokTypes.parenL) &&
          this.tsLookAhead(this.tsIsUnambiguouslyStartOfFunctionType.bind(this))
        )
      }

      tsInAllowConditionalTypesContext<T>(cb: () => T): T {
        const oldInDisallowConditionalTypesContext =
          this.inDisallowConditionalTypesContext
        this.inDisallowConditionalTypesContext = false
        try {
          return cb()
        } finally {
          this.inDisallowConditionalTypesContext =
            oldInDisallowConditionalTypesContext
        }
      }

      tsParseBindingListForSignature(): Array<Identifier | RestElement | ObjectPattern | ArrayPattern> {
        return super
          .parseBindingList(tokTypes.parenR, true, true)
          .map(pattern => {
            if (
              pattern.type !== 'Identifier' &&
              pattern.type !== 'RestElement' &&
              pattern.type !== 'ObjectPattern' &&
              pattern.type !== 'ArrayPattern'
            ) {
              this.raise(pattern.loc.start, TSErrors.UnsupportedSignatureParameterKind(pattern.type))
            }
            return pattern as any
          })
      }

      tsParseTypePredicateAsserts(): boolean {
        if (this.type !== tsTokenType.asserts) {
          return false
        }
        const containsEsc = this.containsEsc
        this.next()
        if (!tokenIsIdentifier(this.type) && !this.match(tokTypes._this)) {
          return false
        }

        if (containsEsc) {
          this.raise(this.lastTokStart, 'Escape sequence in keyword'
            + ' asserts')
        }

        return true
      }

      tsParseThisTypeNode() {
        const node = this.startNode()
        this.next()
        return this.finishNode(node, 'TSThisType')
      }

      tsParseTypeAnnotation(
        eatColon = true,
        t: Node = this.startNode()
      ): Node {
        this.tsInType(() => {
          if (eatColon) this.expect(tokTypes.colon)
          t.typeAnnotation = this.tsParseType()
        })
        return this.finishNode(t, 'TSTypeAnnotation')
      }

      tsParseThisTypePredicate(lhs: any) {
        this.next()
        const node = this.startNodeAtNode(lhs)
        node.parameterName = lhs
        node.typeAnnotation = this.tsParseTypeAnnotation(/* eatColon */ false)
        node.asserts = false
        return this.finishNode(node, 'TSTypePredicate')
      }

      tsParseThisTypeOrThisTypePredicate(): Node {
        const thisKeyword = this.tsParseThisTypeNode()
        if (this.ts_isContextual(tsTokenType.is) && !this.hasPrecedingLineBreak()) {
          return this.tsParseThisTypePredicate(thisKeyword)
        } else {
          return thisKeyword
        }
      }

      tsParseTypePredicatePrefix(): Identifier | undefined | null {
        const id = this.parseIdent()
        if (this.ts_isContextual(tsTokenType.is) && !this.hasPrecedingLineBreak()) {
          this.next()
          return id
        }
      }

      tsParseTypeOrTypePredicateAnnotation(
        returnToken: TokenType
      ): Node {
        return this.tsInType(() => {
          const t = this.startNode()
          this.expect(returnToken)

          const node = this.startNode()

          const asserts = !!this.tsTryParse(
            this.tsParseTypePredicateAsserts.bind(this)
          )

          if (asserts && this.match(tokTypes._this)) {
            // When asserts is false, thisKeyword is handled by tsParseNonArrayType
            // : asserts this is type
            let thisTypePredicate = this.tsParseThisTypeOrThisTypePredicate()
            // if it turns out to be a `TSThisType`, wrap it with `TSTypePredicate`
            // : asserts this
            if (thisTypePredicate.type === 'TSThisType') {
              node.parameterName = thisTypePredicate
              node.asserts = true
              node.typeAnnotation = null
              thisTypePredicate = this.finishNode(node, 'TSTypePredicate')
            } else {
              this.resetStartLocationFromNode(thisTypePredicate, node)
              thisTypePredicate.asserts = true
            }
            t.typeAnnotation = thisTypePredicate
            return this.finishNode(t, 'TSTypeAnnotation')
          }

          const typePredicateVariable =
            this.tsIsIdentifier() &&
            this.tsTryParse(this.tsParseTypePredicatePrefix.bind(this))

          if (!typePredicateVariable) {
            if (!asserts) {
              // : type
              return this.tsParseTypeAnnotation(/* eatColon */ false, t)
            }

            // : asserts foo
            node.parameterName = this.parseIdent()
            node.asserts = asserts
            node.typeAnnotation = null
            t.typeAnnotation = this.finishNode(node, 'TSTypePredicate')
            return this.finishNode(t, 'TSTypeAnnotation')
          }

          // : asserts foo is type
          const type = this.tsParseTypeAnnotation(/* eatColon */ false)
          node.parameterName = typePredicateVariable
          node.typeAnnotation = type
          node.asserts = asserts
          t.typeAnnotation = this.finishNode(node, 'TSTypePredicate')
          return this.finishNode(t, 'TSTypeAnnotation')
        })
      }

      // Note: In TypeScript implementation we must provide `yieldContext` and `awaitContext`,
      // but here it's always false, because this is only used for types.
      tsFillSignature(
        returnToken: TokenType,
        signature: Node
      ): void {
        // Arrow fns *must* have return token (`=>`). Normal functions can omit it.
        const returnTokenRequired = returnToken === tokTypes.arrow

        // https://github.com/babel/babel/issues/9231
        const paramsKey = 'parameters'
        const returnTypeKey = 'typeAnnotation'

        signature.typeParameters = this.tsTryParseTypeParameters()
        this.expect(tokTypes.parenL)
        signature[paramsKey] = this.tsParseBindingListForSignature()
        if (returnTokenRequired) {
          signature[returnTypeKey] =
            this.tsParseTypeOrTypePredicateAnnotation(returnToken)
        } else if (this.match(returnToken)) {
          signature[returnTypeKey] =
            this.tsParseTypeOrTypePredicateAnnotation(returnToken)
        }
      }

      tsParseFunctionOrConstructorType(
        type: 'TSFunctionType' | 'TSConstructorType',
        abstract?: boolean
      ) {
        const node = this.startNode()
        if (type === 'TSConstructorType') {
          node.abstract = !!abstract
          if (abstract) this.next()
          this.next() // eat `new`
        }
        this.tsInAllowConditionalTypesContext(() =>
          this.tsFillSignature(tokTypes.arrow, node)
        )
        return this.finishNode(node, type)
      }

      tsParseUnionOrIntersectionType(
        kind: 'TSUnionType' | 'TSIntersectionType',
        parseConstituentType: () => Node,
        operator: TokenType
      ): Node {
        const node = this.startNode()
        const hasLeadingOperator = this.eat(operator)
        const types = []
        do {
          types.push(parseConstituentType())
        } while (this.eat(operator))
        if (types.length === 1 && !hasLeadingOperator) {
          return types[0]
        }
        node.types = types
        return this.finishNode(node, kind)
      }

      tsCheckTypeAnnotationForReadOnly(node: Node) {
        switch (node.typeAnnotation.type) {
          case 'TSTupleType':
          case 'TSArrayType':
            return
          default:
            this.raise(node.loc.start, TSErrors.UnexpectedReadonly)
        }
      }

      tsParseTypeOperator(): Node {
        const node = this.startNode()
        const operator = this.value
        this.next() // eat operator
        node.operator = operator
        node.typeAnnotation = this.tsParseTypeOperatorOrHigher()

        if (operator === 'readonly') {
          this.tsCheckTypeAnnotationForReadOnly(
            // @ts-expect-error todo(flow->ts)
            node
          )
        }

        return this.finishNode(node, 'TSTypeOperator')
      }

      tsParseConstraintForInferType() {
        if (this.eat(tokTypes._extends)) {
          const constraint = this.tsInDisallowConditionalTypesContext(() =>
            this.tsParseType()
          )
          if (
            this.inDisallowConditionalTypesContext ||
            !this.match(tokTypes.question)
          ) {
            return constraint
          }
        }
      }

      tsParseInferType(): Node {
        const node = this.startNode()
        this.expectContextual('infer')
        const typeParameter = this.startNode()
        typeParameter.name = this.tsParseTypeParameterName()
        typeParameter.constraint = this.tsTryParse(() =>
          this.tsParseConstraintForInferType()
        )
        node.typeParameter = this.finishNode(typeParameter, 'TSTypeParameter')
        return this.finishNode(node, 'TSInferType')
      }

      tsParseLiteralTypeNode(): Node {
        const node = this.startNode()
        // @ts-expect-error refine typings
        node.literal = (() => {
          switch (this.type) {
            case tokTypes.num:
            // we don't need bigint type here
            // case tokTypes.bigint:
            case tokTypes.string:
            case tokTypes._true:
            case tokTypes._false:
              // For compatibility to estree we cannot call parseLiteral directly here
              return super.parseExprAtom()
            default:
              this.unexpected()
          }
        })()
        return this.finishNode(node, 'TSLiteralType')
      }

      tsParseImportType(): Node {
        const node = this.startNode()
        this.expect(tokTypes._import)
        this.expect(tokTypes.parenL)
        if (!this.match(tokTypes.string)) {
          this.raise(this.start, TSErrors.UnsupportedImportTypeArgument)
        }

        // For compatibility to estree we cannot call parseLiteral directly here
        node.argument = super.parseExprAtom()
        this.expect(tokTypes.parenR)

        if (this.eat(tokTypes.dot)) {
          // In this instance, the entity name will actually itself be a
          // qualifier, so allow it to be a reserved word as well.
          node.qualifier = this.tsParseEntityName()
        }
        if (this.match(tokTypes.relational)) {
          node.typeParameters = this.tsParseTypeArguments()
        }
        return this.finishNode(node, 'TSImportType')
      }

      tsParseTypeQuery(): Node {
        const node = this.startNode()
        this.expect(tokTypes._typeof)
        if (this.match(tokTypes._import)) {
          node.exprName = this.tsParseImportType()
        } else {
          node.exprName = this.tsParseEntityName()
        }
        if (!this.hasPrecedingLineBreak() && this.match(tt.lt)) {
          node.typeParameters = this.tsParseTypeArguments()
        }
        return this.finishNode(node, 'TSTypeQuery')
      }

      tsParseMappedTypeParameter(): Node {
        const node = this.startNode()
        node.name = this.tsParseTypeParameterName()
        node.constraint = this.tsExpectThenParseType(tokTypes._in)
        return this.finishNode(node, 'TSTypeParameter')
      }

      tsParseMappedType(): Node {
        const node = this.startNode()

        this.expect(tokTypes.braceL)

        if (this.match(tokTypes.plusMin)) {
          node.readonly = this.value
          this.next()
          this.expectContextual('readonly')
        } else if (this.eatContextual(tsTokenType.readonly)) {
          node.readonly = true
        }

        this.expect(tokTypes.bracketL)
        node.typeParameter = this.tsParseMappedTypeParameter()
        node.nameType = this.eatContextual(tsTokenType.as) ? this.tsParseType() : null

        this.expect(tokTypes.bracketR)

        if (this.match(tokTypes.plusMin)) {
          node.optional = this.value
          this.next()
          this.expect(tokTypes.question)
        } else if (this.eat(tokTypes.question)) {
          node.optional = true
        }

        node.typeAnnotation = this.tsTryParseType()
        this.semicolon()
        this.expect(tokTypes.braceR)

        return this.finishNode(node, 'TSMappedType')
      }

      tsParseTypeLiteral(): Node {
        const node = this.startNode()
        node.members = this.tsParseObjectTypeMembers()
        return this.finishNode(node, 'TSTypeLiteral')
      }

      tsParseTupleElementType(): Node {
        // parses `...TsType[]`

        const { start: startPos, startLoc } = this

        const rest = this.eat(tokTypes.ellipsis)
        let type: any = this.tsParseType()
        const optional = this.eat(tokTypes.question)
        const labeled = this.eat(tokTypes.colon)

        if (labeled) {
          const labeledNode = this.startNodeAtNode(type)
          labeledNode.optional = optional

          if (
            type.type === 'TSTypeReference' &&
            !type.typeParameters &&
            type.typeName.type === 'Identifier'
          ) {
            labeledNode.label = type.typeName as Identifier
          } else {
            this.raise(type.start, TSErrors.InvalidTupleMemberLabel)
            // @ts-expect-error This produces an invalid AST, but at least we don't drop
            // nodes representing the invalid source.
            labeledNode.label = type
          }

          labeledNode.elementType = this.tsParseType()
          type = this.finishNode(labeledNode, 'TSNamedTupleMember')
        } else if (optional) {
          const optionalTypeNode = this.startNodeAtNode<N.TsOptionalType>(type)
          optionalTypeNode.typeAnnotation = type
          type = this.finishNode(optionalTypeNode, 'TSOptionalType')
        }

        if (rest) {
          const restNode = this.startNodeAt(startPos, startLoc)
          restNode.typeAnnotation = type
          type = this.finishNode(restNode, 'TSRestType')
        }

        return type
      }

      tsParseTupleType(): Node {
        const node = this.startNode()
        node.elementTypes = this.tsParseBracketedList(
          'TupleElementTypes',
          this.tsParseTupleElementType.bind(this),
          /* bracket */ true,
          /* skipFirstToken */ false
        )

        // Validate the elementTypes to ensure that no mandatory elements
        // follow optional elements
        let seenOptionalElement = false
        let labeledElements: boolean | null = null
        node.elementTypes.forEach(elementNode => {
          const { type } = elementNode

          if (
            seenOptionalElement &&
            type !== 'TSRestType' &&
            type !== 'TSOptionalType' &&
            !(type === 'TSNamedTupleMember' && elementNode.optional)
          ) {
            this.raise(elementNode.start, TSErrors.OptionalTypeBeforeRequired)
          }

          seenOptionalElement ||=
            (type === 'TSNamedTupleMember' && elementNode.optional) ||
            type === 'TSOptionalType'

          // When checking labels, check the argument of the spread operator
          let checkType = type
          if (type === 'TSRestType') {
            elementNode = elementNode.typeAnnotation
            checkType = elementNode.type
          }

          const isLabeled = checkType === 'TSNamedTupleMember'
          labeledElements ??= isLabeled
          if (labeledElements !== isLabeled) {
            this.raise(elementNode.start, TSErrors.MixedLabeledAndUnlabeledElements)
          }
        })

        return this.finishNode(node, 'TSTupleType')
      }

      tsParseTemplateLiteralType(): Node {
        const node = this.startNode()
        node.literal = super.parseTemplate({ isTagged: false })
        return this.finishNode(node, 'TSLiteralType')
      }

      tsParseTypeReference(): Node {
        const node = this.startNode()
        node.typeName = this.tsParseEntityName()
        if (!this.hasPrecedingLineBreak() && this.match(tokTypes.relational)) {
          node.typeParameters = this.tsParseTypeArguments()
        }
        return this.finishNode(node, 'TSTypeReference')
      }

      tsParseParenthesizedType(): N.TsParenthesizedType {
        const node = this.startNode()
        this.expect(tokTypes.parenL)
        node.typeAnnotation = this.tsParseType()
        this.expect(tokTypes.parenR)
        return this.finishNode(node, 'TSParenthesizedType')
      }

      tsParseNonArrayType(): Node {
        switch (this.type) {
          case tokTypes.string:
          case tokTypes.num:
          // we don't need bigint type here
          // case tokTypes.bigint:
          case tokTypes._true:
          case tokTypes._false:
            return this.tsParseLiteralTypeNode()
          case tokTypes.plusMin:
            if (this.value === '-') {
              const node = this.startNode()
              const nextToken = this.lookahead()
              if (
                nextToken.type !== tokTypes.num
                // && nextToken.type !== tsTokenType.bigint
              ) {
                this.unexpected()
              }
              // @ts-expect-error: parseMaybeUnary must returns unary expression
              node.literal = this.parseMaybeUnary()
              return this.finishNode(node, 'TSLiteralType')
            }
            break
          case tokTypes._this:
            return this.tsParseThisTypeOrThisTypePredicate()
          case tokTypes._typeof:
            return this.tsParseTypeQuery()
          case tokTypes._import:
            return this.tsParseImportType()
          case tokTypes.braceL:
            return this.tsLookAhead(this.tsIsStartOfMappedType.bind(this))
              ? this.tsParseMappedType()
              : this.tsParseTypeLiteral()
          case tokTypes.bracketL:
            return this.tsParseTupleType()
          case tokTypes.parenL:
            // the following line will always be false
            // if (!this.options.createParenthesizedExpressions) {
            // const startPos = this.start
            // this.next()
            // const type = this.tsParseType()
            // this.expect(tokTypes.parenR)
            // this.addExtra(type, 'parenthesized', true)
            // this.addExtra(type, 'parenStart', startPos)
            // return type
            // }

            return this.tsParseParenthesizedType()
          // parse template string here
          case tokTypes.backQuote:
          case tokTypes.dollarBraceL:
            return this.tsParseTemplateLiteralType()
          default: {
            const { type } = this
            if (
              tokenIsIdentifier(type) ||
              type === tokTypes._void ||
              type === tokTypes._null
            ) {
              const nodeType =
                type === tokTypes._void
                  ? 'TSVoidKeyword'
                  : type === tokTypes._null
                    ? 'TSNullKeyword'
                    : keywordTypeFromName(this.value)
              if (
                nodeType !== undefined &&
                this.lookaheadCharCode() !== charCodes.dot
              ) {
                const node = this.startNode()
                this.next()
                return this.finishNode(node, nodeType)
              }
              return this.tsParseTypeReference()
            }
          }
        }

        this.unexpected()
      }

      tsParseArrayTypeOrHigher(): Node {
        let type = this.tsParseNonArrayType()
        while (!this.hasPrecedingLineBreak() && this.eat(tokTypes.bracketL)) {
          if (this.match(tokTypes.bracketR)) {
            const node = this.startNodeAtNode(type)
            node.elementType = type
            this.expect(tokTypes.bracketR)
            type = this.finishNode(node, 'TSArrayType')
          } else {
            const node = this.startNodeAtNode(type)
            node.objectType = type
            node.indexType = this.tsParseType()
            this.expect(tokTypes.bracketR)
            type = this.finishNode(node, 'TSIndexedAccessType')
          }
        }
        return type
      }

      tsParseTypeOperatorOrHigher(): Node {
        const isTypeOperator =
          tokenIsTSTypeOperator(this.type) && !this.containsEsc
        return isTypeOperator
          ? this.tsParseTypeOperator()
          : this.ts_isContextual(tsTokenType.infer)
            ? this.tsParseInferType()
            : this.tsInAllowConditionalTypesContext(() =>
              this.tsParseArrayTypeOrHigher()
            )
      }

      tsParseIntersectionTypeOrHigher(): N.TsType {
        return this.tsParseUnionOrIntersectionType(
          'TSIntersectionType',
          this.tsParseTypeOperatorOrHigher.bind(this),
          tokTypes.bitwiseAND
        )
      }

      tsParseUnionTypeOrHigher() {
        return this.tsParseUnionOrIntersectionType(
          'TSUnionType',
          this.tsParseIntersectionTypeOrHigher.bind(this),
          tokTypes.bitwiseOR
        )
      }

      tsParseNonConditionalType(): Node {
        if (this.tsIsStartOfFunctionType()) {
          return this.tsParseFunctionOrConstructorType('TSFunctionType')
        }
        if (this.match(tokTypes._new)) {
          // As in `new () => Date`
          return this.tsParseFunctionOrConstructorType('TSConstructorType')
        } else if (this.isAbstractConstructorSignature()) {
          // As in `abstract new () => Date`
          return this.tsParseFunctionOrConstructorType(
            'TSConstructorType',
            /* abstract */ true
          )
        }
        return this.tsParseUnionTypeOrHigher()
      }

      /** Be sure to be in a type context before calling this, using `tsInType`. */
      tsParseType(): Node {
        // Need to set `state.inType` so that we don't parse JSX in a type context.
        assert(this.inType)
        const type = this.tsParseNonConditionalType()

        if (
          this.inDisallowConditionalTypesContext ||
          this.hasPrecedingLineBreak() ||
          !this.eat(tokTypes._extends)
        ) {
          return type
        }
        const node = this.startNodeAtNode<N.TsConditionalType>(type)
        node.checkType = type

        node.extendsType = this.tsInDisallowConditionalTypesContext(() =>
          this.tsParseNonConditionalType()
        )

        this.expect(tokTypes.question)
        node.trueType = this.tsInAllowConditionalTypesContext(() =>
          this.tsParseType()
        )

        this.expect(tokTypes.colon)
        node.falseType = this.tsInAllowConditionalTypesContext(() =>
          this.tsParseType()
        )

        return this.finishNode(node, 'TSConditionalType')
      }

      /**
       * Runs `cb` in a type context.
       * This should be called one token *before* the first type token,
       * so that the call to `next()` is run in type context.
       */
      tsInType<T>(cb: () => T): T {
        const oldInType = this.inType
        this.inType = true
        try {
          return cb()
        } finally {
          this.inType = oldInType
        }
      }

      tsParseTypeParameter(
        parseModifiers: (
          node: Node
        ) => void = this.tsParseNoneModifiers.bind(this)
      ): Node {
        const node = this.startNode()

        parseModifiers(node)

        node.name = this.tsParseTypeParameterName()
        node.constraint = this.tsEatThenParseType(tokTypes._extends)
        node.default = this.tsEatThenParseType(tokTypes.eq)
        return this.finishNode(node, 'TSTypeParameter')
      }

      tsParseTypeParameters(
        parseModifiers?: ((node) => void) | null
      ) {
        const node = this.startNode()

        // todo support jsx
        if (this.match(tokTypes.relational) || this.match(jsxTokenType.jsxTagStart)) {
          this.next()
        } else {
          this.unexpected()
        }

        const refTrailingCommaPos = { value: -1 }

        node.params = this.tsParseBracketedList(
          'TypeParametersOrArguments',
          // @ts-expect-error refine typings
          this.tsParseTypeParameter.bind(this, parseModifiers),
          /* bracket */ false,
          /* skipFirstToken */ true,
          refTrailingCommaPos
        )
        if (node.params.length === 0) {
          this.raise(this.start, TSErrors.EmptyTypeParameters)
        }
        if (refTrailingCommaPos.value !== -1) {
          this.addExtra(node, 'trailingComma', refTrailingCommaPos.value)
        }
        return this.finishNode(node, 'TSTypeParameterDeclaration')
      }

      tsTryParseTypeParameters(
        parseModifiers?: ((node) => void) | null
      ) {
        if (this.match(tokTypes.relational)) {
          return this.tsParseTypeParameters(parseModifiers)
        }
      }

      tsTryParse<T>(f: () => T | undefined | false): T | undefined {
        const state = this.getCurLookaheadState()
        const result = f()
        if (result !== undefined && result !== false) {
          return result
        } else {
          this.setLookaheadState(state)
          return undefined
        }
      }

      tsTokenCanFollowModifier() {
        return (
          (this.match(tokTypes.bracketL) ||
            this.match(tokTypes.braceL) ||
            this.match(tokTypes.star) ||
            this.match(tokTypes.ellipsis) ||
            this.match(tokTypes.privateId) ||
            this.isLiteralPropertyName()) &&
          !this.hasPrecedingLineBreak()
        )
      }

      tsNextTokenCanFollowModifier() {
        // Note: TypeScript's implementation is much more complicated because
        // more things are considered modifiers there.
        // This implementation only handles modifiers not handled by @babel/parser itself. And "static".
        // TODO: Would be nice to avoid lookahead. Want a hasLineBreakUpNext() method...
        this.next()
        return this.tsTokenCanFollowModifier()
      }

      /** Parses a modifier matching one the given modifier names. */
      tsParseModifier<T extends TsModifier>(
        allowedModifiers: T[],
        stopOnStartOfClassStaticBlock?: boolean
      ): T | undefined | null {
        if (!tokenIsIdentifier(this.type) && this.type !== tokTypes._in) {
          return undefined
        }

        const modifier = this.value
        if (allowedModifiers.indexOf(modifier) !== -1) {
          if (stopOnStartOfClassStaticBlock && this.tsIsStartOfStaticBlocks()) {
            return undefined
          }
          if (this.tsTryParse(this.tsNextTokenCanFollowModifier.bind(this))) {
            return modifier
          }
        }
        return undefined
      }

      /** Parses a list of modifiers, in any order.
       *  If you need a specific order, you must call this function multiple times:
       *    this.tsParseModifiers({ modified: node, allowedModifiers: ['public'] });
       *    this.tsParseModifiers({ modified: node, allowedModifiers: ["abstract", "readonly"] });
       */
      tsParseModifiers({
        modified,
        allowedModifiers,
        disallowedModifiers,
        stopOnStartOfClassStaticBlock,
        errorTemplate = TSErrors.InvalidModifierOnTypeMember
      }: {
        modified: ModifierBase;
        allowedModifiers: readonly TsModifier[];
        disallowedModifiers?: TsModifier[];
        stopOnStartOfClassStaticBlock?: boolean;
        // FIXME: make sure errorTemplate can receive `modifier`
        errorTemplate?: any;
      }): void {
        const enforceOrder = (
          loc: Position,
          modifier: TsModifier,
          before: TsModifier,
          after: TsModifier
        ) => {
          if (modifier === before && modified[after]) {
            this.raise(this.start, TSErrors.InvalidModifiersOrder)
          }
        }
        const incompatible = (
          loc: Position,
          modifier: TsModifier,
          mod1: TsModifier,
          mod2: TsModifier
        ) => {
          if (
            (modified[mod1] && modifier === mod2) ||
            (modified[mod2] && modifier === mod1)
          ) {
            this.raise(this.start, TSErrors.IncompatibleModifiers)
          }
        }

        for (; ;) {
          const { startLoc } = this
          const modifier: TsModifier | undefined | null = this.tsParseModifier(
            allowedModifiers.concat(disallowedModifiers ?? []),
            stopOnStartOfClassStaticBlock
          )

          if (!modifier) break

          if (tsIsAccessModifier(modifier)) {
            if (modified.accessibility) {
              this.raise(this.start, TSErrors.DuplicateAccessibilityModifier)
            } else {
              enforceOrder(startLoc, modifier, modifier, 'override')
              enforceOrder(startLoc, modifier, modifier, 'static')
              enforceOrder(startLoc, modifier, modifier, 'readonly')

              modified.accessibility = modifier
            }
          } else if (tsIsVarianceAnnotations(modifier)) {
            if (modified[modifier]) {
              this.raise(this.start, TSErrors.DuplicateModifier)
            }
            modified[modifier] = true

            enforceOrder(startLoc, modifier, 'in', 'out')
          } else {
            if (Object.hasOwnProperty.call(modified, modifier)) {
              this.raise(this.start, TSErrors.DuplicateModifier)
            } else {
              enforceOrder(startLoc, modifier, 'static', 'readonly')
              enforceOrder(startLoc, modifier, 'static', 'override')
              enforceOrder(startLoc, modifier, 'override', 'readonly')
              enforceOrder(startLoc, modifier, 'abstract', 'override')

              incompatible(startLoc, modifier, 'declare', 'override')
              incompatible(startLoc, modifier, 'static', 'abstract')
            }
            modified[modifier] = true
          }

          if (disallowedModifiers?.includes(modifier)) {
            this.raise(this.start, errorTemplate)
          }
        }
      }

      tsParseInOutModifiers(node: Node) {
        this.tsParseModifiers({
          modified: node,
          allowedModifiers: ['in', 'out'],
          disallowedModifiers: [
            'public',
            'private',
            'protected',
            'readonly',
            'declare',
            'abstract',
            'override'
          ],
          errorTemplate: TSErrors.InvalidModifierOnTypeParameter
        })
      }

      tsParseTypeArguments(): Node {
        const node = this.startNode()
        node.params = this.tsInType(() =>
          // Temporarily remove a JSX parsing context, which makes us scan different tokens.
          this.tsInNoContext(() => {
            this.expect(tokTypes.relational)
            return this.tsParseDelimitedList(
              'TypeParametersOrArguments',
              this.tsParseType.bind(this)
            )
          })
        )
        if (node.params.length === 0) {
          this.raise(this.start, TSErrors.EmptyTypeArguments)
        }
        this.expect(tokTypes.relational)
        return this.finishNode(node, 'TSTypeParameterInstantiation')
      }

      tsParseHeritageClause(
        token: 'extends' | 'implements'
      ): Array<Node> {
        const originalStart = this.start

        const delimitedList = this.tsParseDelimitedList(
          'HeritageClauseElement',
          () => {
            const node = this.startNode()
            node.expression = this.tsParseEntityName()
            if (this.match(tokTypes.relational)) {
              node.typeParameters = this.tsParseTypeArguments()
            }

            return this.finishNode(node, 'TSExpressionWithTypeArguments')
          }
        )

        if (!delimitedList.length) {
          this.raise(originalStart, TSErrors.EmptyHeritageClauseType(token))
        }

        return delimitedList
      }

      tsParseTypeMemberSemicolon(): void {
        if (!this.eat(tokTypes.comma) && !this.isLineTerminator()) {
          this.expect(tokTypes.semi)
        }
      }

      tsParseSignatureMember(
        kind: 'TSCallSignatureDeclaration' | 'TSConstructSignatureDeclaration',
        node: Node
      ): Node {
        this.tsFillSignature(tokTypes.colon, node)
        this.tsParseTypeMemberSemicolon()
        return this.finishNode(node, kind)
      }

      tsParsePropertyOrMethodSignature(
        node: Node,
        readonly: boolean
      ): Node {
        if (this.eat(tokTypes.question)) node.optional = true
        const nodeAny: any = node

        if (this.match(tokTypes.parenL) || this.match(tokTypes.relational)) {
          if (readonly) {
            this.raise(node.start, TSErrors.ReadonlyForMethodSignature)
          }
          const method = nodeAny
          if (method.kind && this.match(tokTypes.relational)) {
            this.raise(this.start, TSErrors.AccesorCannotHaveTypeParameters)
          }
          this.tsFillSignature(tokTypes.colon, method)
          this.tsParseTypeMemberSemicolon()
          const paramsKey = 'parameters'
          const returnTypeKey = 'typeAnnotation'
          if (method.kind === 'get') {
            if (method[paramsKey].length > 0) {
              this.raise(this.start, 'A \'get\' accesor must not have any formal parameters.')
              if (this.isThisParam(method[paramsKey][0])) {
                this.raise(this.start, TSErrors.AccesorCannotDeclareThisParameter)
              }
            }
          } else if (method.kind === 'set') {
            if (method[paramsKey].length !== 1) {
              this.raise(this.start, 'A \'get\' accesor must'
                + ' not have any formal parameters.')
            } else {
              const firstParameter = method[paramsKey][0]
              if (this.isThisParam(firstParameter)) {
                this.raise(this.start, TSErrors.AccesorCannotDeclareThisParameter)
              }
              if (
                firstParameter.type === 'Identifier' &&
                firstParameter.optional
              ) {
                this.raise(this.start, TSErrors.SetAccesorCannotHaveOptionalParameter)
              }
              if (firstParameter.type === 'RestElement') {
                this.raise(this.start, TSErrors.SetAccesorCannotHaveRestParameter)
              }
            }
            if (method[returnTypeKey]) {
              this.raise(method[returnTypeKey].start, TSErrors.SetAccesorCannotHaveReturnType)
            }
          } else {
            method.kind = 'method'
          }
          return this.finishNode(method, 'TSMethodSignature')
        } else {
          const property = nodeAny
          if (readonly) property.readonly = true
          const type = this.tsTryParseTypeAnnotation()
          if (type) property.typeAnnotation = type
          this.tsParseTypeMemberSemicolon()
          return this.finishNode(property, 'TSPropertySignature')
        }
      }

      tsParseTypeMember(): Node {
        const node: any = this.startNode()

        if (this.match(tokTypes.parenL) || this.match(tokTypes.relational)) {
          return this.tsParseSignatureMember('TSCallSignatureDeclaration', node)
        }

        if (this.match(tokTypes._new)) {
          const id = this.startNode<Identifier>()
          this.next()
          if (this.match(tokTypes.parenL) || this.match(tokTypes.relational)) {
            return this.tsParseSignatureMember(
              'TSConstructSignatureDeclaration',
              node
            )
          } else {
            node.key = this.createIdentifier(id, 'new')
            return this.tsParsePropertyOrMethodSignature(node, false)
          }
        }

        this.tsParseModifiers({
          modified: node,
          allowedModifiers: ['readonly'],
          disallowedModifiers: [
            'declare',
            'abstract',
            'private',
            'protected',
            'public',
            'static',
            'override'
          ]
        })

        const idx = this.tsTryParseIndexSignature(node)
        if (idx) {
          return idx
        }

        super.parsePropertyName(node)
        if (
          !node.computed &&
          node.key.type === 'Identifier' &&
          (node.key.name === 'get' || node.key.name === 'set') &&
          this.tsTokenCanFollowModifier()
        ) {
          node.kind = node.key.name
          super.parsePropertyName(node)
        }
        return this.tsParsePropertyOrMethodSignature(node, !!node.readonly)
      }

      tsParseList<T extends N.Node>(
        kind: ParsingContext,
        parseElement: () => T
      ): T[] {
        const result: T[] = []
        while (!this.tsIsListTerminator(kind)) {
          // Skipping "parseListElement" from the TS source since that's just for error handling.
          result.push(parseElement())
        }
        return result
      }

      tsParseObjectTypeMembers(): Array<Node> {
        this.expect(tokTypes.braceL)
        const members = this.tsParseList(
          'TypeMembers',
          this.tsParseTypeMember.bind(this)
        )
        this.expect(tokTypes.braceR)
        return members
      }

      tsParseInterfaceDeclaration(
        node: Undone<N.TsInterfaceDeclaration>,
        properties: {
          declare?: true;
        } = {}
      ): N.TsInterfaceDeclaration | undefined | null {
        if (this.hasFollowingLineBreak()) return null
        this.expectContextual('interface')
        if (properties.declare) node.declare = true
        if (tokenIsIdentifier(this.type)) {
          node.id = this.parseIdent()
          this.checkLValSimple(node.id, BIND_TS_INTERFACE)
        } else {
          node.id = null
          this.raise(this.start, TSErrors.MissingInterfaceName)
        }

        node.typeParameters = this.tsTryParseTypeParameters(
          this.tsParseInOutModifiers.bind(this)
        )
        if (this.eat(tokTypes._extends)) {
          node.extends = this.tsParseHeritageClause('extends')
        }
        const body = this.startNode()
        body.body = this.tsInType(this.tsParseObjectTypeMembers.bind(this))
        node.body = this.finishNode(body, 'TSInterfaceBody')
        return this.finishNode(node, 'TSInterfaceDeclaration')
      }

      tsParseAbstractDeclaration(
        node: any
      ): Node | undefined | null {
        if (this.match(tokTypes._class)) {
          node.abstract = true
          return this.parseClass(node, true)
        } else if (this.ts_isContextual(tsTokenType.interface)) {
          // for invalid abstract interface

          // To avoid
          //   abstract interface
          //   Foo {}
          if (!this.hasFollowingLineBreak()) {
            node.abstract = true
            return this.tsParseInterfaceDeclaration(
              node
            )
          }
        } else {
          this.unexpected(null, tokTypes._class)
        }
      }

      tsIsDeclarationStart(): boolean {
        return tokenIsTSDeclarationStart(this.type)
      }

      tsParseExpressionStatement(
        node,
        expr
      ) {
        switch (expr.name) {
          case 'declare': {
            const declaration = this.tsTryParseDeclare(node)
            if (declaration) {
              declaration.declare = true
              return declaration
            }
            break
          }
          case 'global':
            // `global { }` (with no `declare`) may appear inside an ambient module declaration.
            // Would like to use tsParseAmbientExternalModuleDeclaration here, but already ran past "global".
            if (this.match(tokTypes.braceL)) {
              super.enterScope(SCOPE_TS_MODULE)
              const mod = node
              mod.global = true
              mod.id = expr
              mod.body = this.tsParseModuleBlock()
              super.exitScope()
              return this.finishNode(mod, 'TSModuleDeclaration')
            }
            break

          default:
            return this.tsParseDeclaration(node, expr.name, /* next */ false)
        }
      }

      tsParseModuleReference(): N.TsModuleReference {
        return this.tsIsExternalModuleReference()
          ? this.tsParseExternalModuleReference()
          : this.tsParseEntityName(/* allowReservedWords */ false)
      }

      tsIsExportDefaultSpecifier(): boolean {
        const { type } = this
        const isAsync = this.isAsyncFunction()
        const isLet = this.isLet()
        if (tokenIsIdentifier(type)) {
          if ((isAsync && !this.containsEsc) || isLet) {
            return false
          }
          if (
            (type === tsTokenType.type || type === tsTokenType.interface) &&
            !this.containsEsc
          ) {
            const { type: nextType } = this.lookahead()
            // If we see any variable name other than `from` after `type` keyword,
            // we consider it as flow/typescript type exports
            // note that this approach may fail on some pedantic cases
            // export type from = number
            if (
              (tokenIsIdentifier(nextType) && nextType !== tsTokenType.from) ||
              nextType === tokTypes.braceL
            ) {
              return false
            }
          }
        } else if (!this.match(tokTypes._default)) {
          return false
        }

        const next = this.nextTokenStart()
        const hasFrom = this.isUnparsedContextual(next, 'from')
        if (
          this.input.charCodeAt(next) === charCodes.comma ||
          (tokenIsIdentifier(this.type) && hasFrom)
        ) {
          return true
        }
        // lookahead again when `export default from` is seen
        if (this.match(tokTypes._default) && hasFrom) {
          const nextAfterFrom = this.input.charCodeAt(
            this.nextTokenStartSince(next + 4)
          )
          return (
            nextAfterFrom === charCodes.quotationMark ||
            nextAfterFrom === charCodes.apostrophe
          )
        }
        return false
      }

      tsInAmbientContext<T>(cb: () => T): T {
        const oldIsAmbientContext = this.isAmbientContext
        this.isAmbientContext = true
        try {
          return cb()
        } finally {
          this.isAmbientContext = oldIsAmbientContext
        }
      }

      tsCheckLineTerminator(next: boolean) {
        if (next) {
          if (this.hasFollowingLineBreak()) return false
          this.next()
          return true
        }
        return !this.isLineTerminator()
      }

      tsParseModuleOrNamespaceDeclaration(
        node: Node,
        nested: boolean = false
      ): Node {
        node.id = this.parseIdent()

        if (!nested) {
          this.checkLValSimple(node.id, BIND_TS_NAMESPACE)
        }

        if (this.eat(tokTypes.dot)) {
          const inner = this.startNode()
          this.tsParseModuleOrNamespaceDeclaration(inner, true)
          // @ts-expect-error Fixme: refine typings
          node.body = inner
        } else {
          super.enterScope(SCOPE_TS_MODULE)
          node.body = this.tsParseModuleBlock()
          super.exitScope()
        }
        return this.finishNode(node, 'TSModuleDeclaration')
      }

      tsParseTypeAliasDeclaration(
        node: Node
      ): Node {
        node.id = this.parseIdent()
        this.checkLValSimple(node.id, BIND_TS_TYPE)

        node.typeAnnotation = this.tsInType(() => {
          node.typeParameters = this.tsTryParseTypeParameters(
            this.tsParseInOutModifiers.bind(this)
          )

          this.expect(tokTypes.eq)

          if (
            this.ts_isContextual(tsTokenType.interface) &&
            this.lookahead().type !== tokTypes.dot
          ) {
            const node = this.startNode()
            this.next()
            return this.finishNode(node, 'TSIntrinsicKeyword')
          }

          return this.tsParseType()
        })

        this.semicolon()
        return this.finishNode(node, 'TSTypeAliasDeclaration')
      }

      // Common to tsTryParseDeclare, tsTryParseExportDeclaration, and tsParseExpressionStatement.
      tsParseDeclaration(
        node: any,
        value: string,
        next: boolean
      ): Declaration | undefined | null {
        // no declaration apart from enum can be followed by a line break.
        switch (value) {
          case 'abstract':
            if (
              this.tsCheckLineTerminator(next) &&
              (this.match(tokTypes._class) || tokenIsIdentifier(this.type))
            ) {
              return this.tsParseAbstractDeclaration(node)
            }
            break

          case 'module':
            if (this.tsCheckLineTerminator(next)) {
              if (this.match(tokTypes.string)) {
                return this.tsParseAmbientExternalModuleDeclaration(node)
              } else if (tokenIsIdentifier(this.type)) {
                return this.tsParseModuleOrNamespaceDeclaration(node)
              }
            }
            break

          case 'namespace':
            if (
              this.tsCheckLineTerminator(next) &&
              tokenIsIdentifier(this.type)
            ) {
              return this.tsParseModuleOrNamespaceDeclaration(node)
            }
            break

          case 'type':
            if (
              this.tsCheckLineTerminator(next) &&
              tokenIsIdentifier(this.type)
            ) {
              return this.tsParseTypeAliasDeclaration(node)
            }
            break
        }
      }

      // Note: this won't be called unless the keyword is allowed in `shouldParseExportDeclaration`.
      tsTryParseExportDeclaration(): Declaration | undefined | null {
        return this.tsParseDeclaration(
          this.startNode(),
          this.value,
          /* next */ true
        )
      }

      tsParseImportEqualsDeclaration(
        node,
        isExport?: boolean
      ): Node {
        node.isExport = isExport || false
        node.id = super.parseIdent()
        super.checkLValSimple(node.id, BIND_LEXICAL)
        super.expect(tokTypes.eq)
        const moduleReference = this.tsParseModuleReference()
        if (
          node.importKind === 'type' &&
          moduleReference.type !== 'TSExternalModuleReference'
        ) {
          this.raise(moduleReference.start, TypeScriptError.ImportAliasHasImportType)
        }
        node.moduleReference = moduleReference
        super.semicolon()
        return this.finishNode(node, 'TSImportEqualsDeclaration')
      }

      originParseExport(node, exports) {
        // export * from '...'
        if (this.eat(tokTypes.star)) {
          if (super.options.ecmaVersion >= 11) {
            if (this.eatContextual('as')) {
              node.exported = super.parseModuleExportName()
              super.checkExport(exports, node.exported, super.lastTokStart)
            } else {
              node.exported = null
            }
          }
          this.expectContextual('from')
          if (this.type !== tokTypes.string) this.unexpected()
          node.source = super.parseExprAtom()
          super.semicolon()
          return this.finishNode(node, 'ExportAllDeclaration')
        }
        if (this.eat(tokTypes._default)) { // export default ...
          super.checkExport(exports, 'default', this.lastTokStart)
          let isAsync
          if (this.type === tokTypes._function || (isAsync = this.isAsyncFunction())) {
            let fNode = super.startNode()
            this.next()
            if (isAsync) this.next()
            node.declaration = this.parseFunction(fNode, FUNC_STATEMENT | FUNC_NULLABLE_ID, false, isAsync)
          } else if (this.type === tokTypes._class) {
            let cNode = super.startNode()
            node.declaration = this.parseClass(cNode, 'nullableID')
          } else {
            node.declaration = super.parseMaybeAssign()
            super.semicolon()
          }
          return super.finishNode(node, 'ExportDefaultDeclaration')
        }
        // export var|const|let|function|class ...
        if (this.shouldParseExportStatement()) {
          node.declaration = this.parseExportDeclaration(node)
          if (node.declaration.type === 'VariableDeclaration')
            super.checkVariableExport(exports, node.declaration.declarations)
          else
            super.checkExport(exports, node.declaration.id, node.declaration.id.start)
          node.specifiers = []
          node.source = null
        } else { // export { x, y as z } [from '...']
          node.declaration = null
          const isTypeExport = node.exportKind === 'type'
          node.specifiers = this.parseExportSpecifiers(exports, isTypeExport)
          if (this.eatContextual('from')) {
            if (this.type !== tokTypes.string) this.unexpected()
            node.source = super.parseExprAtom()
          } else {
            for (let spec of node.specifiers) {
              // check for keywords used as local names
              super.checkUnreserved(spec.local)
              // check if export is defined
              super.checkLocalExport(spec.local)

              if (spec.local.type === 'Literal') {
                super.raise(spec.local.start, 'A string literal cannot be used as an exported binding without `from`.')
              }
            }

            node.source = null
          }
          super.semicolon()
        }
        return super.finishNode(node, 'ExportNamedDeclaration')
      }

      originParseImport(node: Node) {
        if (this.type === tokTypes.string) {
          node.specifiers = empty
          node.source = this.parseExprAtom()
        } else {
          node.specifiers = this.parseImportSpecifiers()
          this.expectContextual('from')
          node.source = this.type === tokTypes.string ? super.parseExprAtom() : this.unexpected()
        }
        super.semicolon()
        return super.finishNode(node, 'ImportDeclaration')
      }

      originParseClass(node, isStatement) {
        this.next()

        // ecma-262 14.6 Class Definitions
        // A class definition is always strict mode code.
        const oldStrict = this.strict
        this.strict = true

        this.parseClassId(node, isStatement)
        this.parseClassSuper(node)
        const privateNameMap = this.enterClassBody()
        const classBody = this.startNode()
        let hadConstructor = false
        classBody.body = []
        this.expect(tokTypes.braceL)
        while (this.type !== tokTypes.braceR) {
          const element = this.parseClassElement(node.superClass !== null)
          if (element) {
            classBody.body.push(element)
            if (element.type === 'MethodDefinition' && element.kind === 'constructor') {
              if (hadConstructor) this.raise(element.start, 'Duplicate constructor in the same class')
              // todo typescript support duplicate constructor
              // hadConstructor = true
            } else if (element.key && element.key.type === 'PrivateIdentifier' && isPrivateNameConflicted(privateNameMap, element)) {
              this.raiseRecoverable(element.key.start, `Identifier '#${element.key.name}' has already been declared`)
            }
          }
        }
        this.strict = oldStrict
        this.next()
        node.body = this.finishNode(classBody, 'ClassBody')
        this.exitClassBody()
        return this.finishNode(node, isStatement ? 'ClassDeclaration' : 'ClassExpression')
      }

      shouldParseExportStatement(): boolean {
        if (this.tsIsDeclarationStart()) return true
        return super.shouldParseExportStatement()
      }

      parseExportDeclaration(
        node: N.ExportNamedDeclaration
      ): N.Declaration | undefined | null {
        if (!this.isAmbientContext && this.ts_isContextual(tsTokenType.declare)) {
          return this.tsInAmbientContext(() => this.parseExportDeclaration(node))
        }

        // Store original location/position
        const startPos = this.start
        const startLoc = this.startLoc

        const isDeclare = this.eatContextual(tsTokenType.declare)

        if (
          isDeclare &&
          (this.ts_isContextual(tsTokenType.declare) || !this.shouldParseExportStatement())
        ) {
          this.raise(this.start, TSErrors.ExpectedAmbientAfterExportDeclare)
        }

        const isIdentifier = tokenIsIdentifier(this.type)
        const declaration =
          (isIdentifier && this.tsTryParseExportDeclaration()) ||
          this.parseStatement(null)

        if (!declaration) return null

        if (
          declaration.type === 'TSInterfaceDeclaration' ||
          declaration.type === 'TSTypeAliasDeclaration' ||
          isDeclare
        ) {
          node.exportKind = 'type'
        }

        if (isDeclare) {
          // Reset location to include `declare` in range
          this.resetStartLocation(declaration, startPos, startLoc)

          declaration.declare = true
        }

        return declaration
      }

      // Note: The reason we do this in `parseExpressionStatement` and not `parseStatement`
      // is that e.g. `type()` is valid JS, so we must try parsing that first.
      // If it's really a type, we will parse `type` as the statement, and can correct it here
      // by parsing the rest.
      // @ts-expect-error plugin overrides interfaces
      parseExpressionStatement(
        node,
        expr
      ) {
        const decl =
          expr.type === 'Identifier'
            ? // @ts-expect-error refine typings
            this.tsParseExpressionStatement(node, expr)
            : undefined
        return decl || super.parseExpressionStatement(node, expr)
      }

      /**
       * @param {Node} node this may be ImportDeclaration |
       * TsImportEqualsDeclaration
       * @returns AnyImport
       * */
      parseImport(
        node: any
      ) {
        this.next()
        node.importKind = 'value'
        if (
          tokenIsIdentifier(this.type) ||
          this.match(tokTypes.star) ||
          this.match(tokTypes.braceL)
        ) {
          let ahead = this.lookahead()
          if (
            this.ts_type_isContextual(this.type, tsTokenType.type) &&
            // import type, { a } from "b";
            ahead.type !== tokTypes.comma &&
            // import type from "a";
            ahead.type !== tsTokenType.from &&
            // import type = require("a");
            ahead.type !== tokTypes.eq
          ) {
            node.importKind = 'type'
            this.next()
            ahead = this.lookahead()
          }

          if (tokenIsIdentifier(this.type) && ahead.type === tokTypes.eq) {
            return this.tsParseImportEqualsDeclaration(node)
          }
        }


        const importNode = this.originParseImport(node)

        /*:: invariant(importNode.type !== "TSImportEqualsDeclaration") */

        // `import type` can only be used on imports with named imports or with a
        // default import - but not both
        if (
          importNode.importKind === 'type' &&
          importNode.specifiers.length > 1 &&
          importNode.specifiers[0].type === 'ImportDefaultSpecifier'
        ) {
          this.raise(importNode.start, TypeScriptError.TypeImportCannotSpecifyDefaultAndNamed)
        }

        return importNode
      }

      parseExport(node: Node): Node {
        debugger
        this.next()
        if (this.match(tokTypes._import)) {
          this.next() // eat `tokTypes._import`
          if (
            this.ts_isContextual(tsTokenType.type) &&
            this.lookaheadCharCode() !== charCodes.equalsTo
          ) {
            node.importKind = 'type'
            this.next() // eat "type"
          } else {
            node.importKind = 'value'
          }
          return this.tsParseImportEqualsDeclaration(
            node,
            /* isExport */ true
          )
        } else if (super.eat(tokTypes.eq)) {
          // `export = x;`
          const assign = node
          assign.expression = super.parseExpression()
          super.semicolon()
          return this.finishNode(assign, 'TSExportAssignment')
        } else if (this.eatContextual(tsTokenType.as)) {
          // `export as namespace A;`
          const decl = node
          // See `parseNamespaceExportDeclaration` in TypeScript's own parser
          this.expectContextual(tsTokenType.namespace)
          decl.id = super.parseIdent()
          super.semicolon()
          return this.finishNode(decl, 'TSNamespaceExportDeclaration')
        } else {
          if (
            this.ts_isContextual(tsTokenType.type) &&
            this.lookahead().type === tokTypes.braceL
          ) {
            this.next()
            node.exportKind = 'type'
          } else {
            node.exportKind = 'value'
          }

          return this.originParseExport(node)
        }
      }

      // Handle type assertions
      parseMaybeUnary(
        refExpressionErrors?: any,
        sawUnary?: boolean
      ): Expression {
        // todo support jsx
        // if (!this.hasPlugin("jsx") && this.match(tt.lt)) {
        //   return this.tsParseTypeAssertion();
        // } else {
        // }

        return super.parseMaybeUnary(refExpressionErrors, sawUnary)
      }

      parseClassField(field) {
        if (checkKeyName(field, 'constructor')) {
          this.raise(field.key.start, 'Classes can\'t have a field named \'constructor\'')
        } else if (field.static && checkKeyName(field, 'prototype')) {
          this.raise(field.key.start, 'Classes can\'t have a static field named \'prototype\'')
        }

        if (this.eat(tokTypes.eq)) {
          // To raise SyntaxError if 'arguments' exists in the initializer.
          const scope = this.currentThisScope()
          const inClassFieldInit = scope.inClassFieldInit
          scope.inClassFieldInit = true
          field.value = this.parseMaybeAssign()
          scope.inClassFieldInit = inClassFieldInit
        } else {
          field.value = null
        }
        this.semicolon()

        return this.finishNode(field, 'PropertyDefinition')
      }

      parseClassMethod(method, isGenerator, isAsync, allowsDirectSuper) {
        // start typescript parse class method
        const isConstructor = method.kind === 'constructor'
        const typeParameters = this.tsTryParseTypeParameters()
        if (typeParameters && isConstructor) {
          this.raise(TSErrors.ConstructorHasTypeParameters, {
            at: typeParameters
          })
        }

        // @ts-expect-error declare does not exist in ClassMethod
        const { declare = false, kind } = method

        if (declare && (kind === 'get' || kind === 'set')) {
          this.raise(TSErrors.DeclareAccessor, { at: method, kind })
        }
        if (typeParameters) method.typeParameters = typeParameters
        // end

        super.parseClassMethod(method, isGenerator, isAsync, allowsDirectSuper)
      }

      parseClassElement(constructorAllowsSuper) {
        if (this.eat(tokTypes.semi)) return null

        const ecmaVersion = this.options.ecmaVersion
        const node = this.startNode()
        let keyName = ''
        let isGenerator = false
        let isAsync = false
        let kind = 'method'
        let isStatic = false

        // todo we don't need parseClassMemberFromModifier here
        //  if (this.parseClassMemberFromModifier(classBody, member)) {
        //     return;
        //  }
        if (this.eatContextual('static')) {
          // Parse static init block
          if (ecmaVersion >= 13 && this.eat(tokTypes.braceL)) {
            this.parseClassStaticBlock(node)
            return node
          }
          if (this.isClassElementNameStart() || this.type === tokTypes.star) {
            isStatic = true
          } else {
            keyName = 'static'
          }
        }
        node.static = isStatic
        // todo we don't need parsePropertyNamePrefixOperator here, this
        //  plugin don't support flow
        //  this.parsePropertyNamePrefixOperator(member);
        if (!keyName && ecmaVersion >= 8 && this.eatContextual('async')) {
          if ((this.isClassElementNameStart() || this.type === tokTypes.star) && !this.canInsertSemicolon()) {
            isAsync = true
          } else {
            keyName = 'async'
          }
        }
        if (!keyName && (ecmaVersion >= 9 || !isAsync) && this.eat(tokTypes.star)) {
          isGenerator = true
        }
        if (!keyName && !isAsync && !isGenerator) {
          const lastValue = this.value
          if (this.eatContextual('get') || this.eatContextual('set')) {
            if (this.isClassElementNameStart()) {
              kind = lastValue
            } else {
              keyName = lastValue
            }
          }
        }

        // Parse element name
        if (keyName) {
          // 'async', 'get', 'set', or 'static' were not a keyword contextually.
          // The last token is any of those. Make it the element name.
          node.computed = false
          node.key = this.startNodeAt(this.lastTokStart, this.lastTokStartLoc)
          node.key.name = keyName
          this.finishNode(node.key, 'Identifier')
        } else {
          this.parseClassElementName(node)
        }

        // todo isClassMethod
        const isClassMethod = this.match(tokTypes.relational) || this.match(tokTypes.parenL)
        // Parse element value
        if (ecmaVersion < 13 || isClassMethod || kind !== 'method' || isGenerator || isAsync) {
          const isConstructor = !node.static && checkKeyName(node, 'constructor')
          const allowsDirectSuper = isConstructor && constructorAllowsSuper
          // Couldn't move this check into the 'parseClassMethod' method for backward compatibility.
          if (isConstructor && kind !== 'method') this.raise(node.key.start, 'Constructor can\'t have get/set modifier')
          node.kind = isConstructor ? 'constructor' : kind
          this.parseClassMethod(node, isGenerator, isAsync, allowsDirectSuper)
        } else {
          this.parseClassField(node)
        }

        return node
      }

      // todo we don't need these functions, we have to rewrite the
      //  parseClassElement function in acorn
      // === === === === === === === === === === === === === === === ===
      // Note: All below methods are duplicates of something in flow.js.
      // Not sure what the best way to combine these is.
      // === === === === === === === === === === === === === === === ===

      // isClassMethod(): boolean {
      //   return this.match(tt.lt) || super.isClassMethod();
      // }
      //
      // isClassProperty(): boolean {
      //   return (
      //     this.match(tt.bang) || this.match(tt.colon) || super.isClassProperty()
      //   );
      // }

      parseMaybeDefault(
        startPos?: number | null,
        startLoc?: Position | null,
        left?: Pattern | null
      ): Pattern {
        const node = super.parseMaybeDefault(startPos, startLoc, left)

        if (
          node.type === 'AssignmentPattern' &&
          node.typeAnnotation &&
          node.right.start < node.typeAnnotation.start
        ) {
          this.raise(node.typeAnnotation.loc.start, TSErrors.TypeAnnotationAfterAssign)
        }

        return node
      }

      toAssignableList(
        exprList: Expression[],
        isLHS: boolean
      ): void {
        for (let i = 0; i < exprList.length; i++) {
          const expr = exprList[i]
          if (expr?.type === 'TSTypeCastExpression') {
            exprList[i] = this.typeCastToParameter(expr)
          }
        }
        super.toAssignableList(exprList, isLHS)
      }

      typeCastToParameter(node: Node): Node {
        node.expression.typeAnnotation = node.typeAnnotation

        this.resetEndLocation(node.expression, node.typeAnnotation.loc.end)

        return node.expression
      }

      // todo we don't need checkCommaAfterRest and shouldParseArrow, achieve this feature in
      //  parseParenAndDistinguishExpression
      // shouldParseArrow(params: Array<N.Node>) {
      //   if (this.match(tt.colon)) {
      //     return params.every(expr => this.isAssignable(expr, true));
      //   }
      //   return super.shouldParseArrow(params);
      // }

      // checkCommaAfterRest(
      //   close: typeof charCodes[keyof typeof charCodes],
      // ): boolean {
      //   if (
      //     this.state.isAmbientContext &&
      //     this.match(tt.comma) &&
      //     this.lookaheadCharCode() === close
      //   ) {
      //     this.next();
      //     return false;
      //   } else {
      //     return super.checkCommaAfterRest(close);
      //   }
      // }

      // todo we don't support Decorator as this version
      // parseMaybeDecoratorArguments(expr: N.Expression): N.Expression {
      //   // handles `@f<<T>`
      //   if (this.match(tt.lt) || this.match(tt.bitShiftL)) {
      //     const typeArguments = this.tsParseTypeArgumentsInExpression();
      //
      //     if (this.match(tt.parenL)) {
      //       const call = super.parseMaybeDecoratorArguments(expr);
      //       call.typeParameters = typeArguments;
      //       return call;
      //     }
      //
      //     this.unexpected(null, tt.parenL);
      //   }
      //
      //   return super.parseMaybeDecoratorArguments(expr);
      // }

      parseParenAndDistinguishExpression(canBeArrow, forInit) {
        let startPos = this.start, startLoc = this.startLoc, val,
          allowTrailingComma = this.options.ecmaVersion >= 8
        if (this.options.ecmaVersion >= 6) {
          this.next()

          let innerStartPos = this.start, innerStartLoc = this.startLoc
          let exprList = [], first = true, lastIsComma = false
          let refDestructuringErrors = new DestructuringErrors,
            oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos,
            spreadStart
          this.yieldPos = 0
          this.awaitPos = 0
          // Do not save awaitIdentPos to allow checking awaits nested in parameters
          while (this.type !== tokTypes.parenR) {
            first ? first = false : this.expect(tokTypes.comma)
            if (allowTrailingComma && this.afterTrailingComma(tokTypes.parenR, true)) {
              lastIsComma = true
              break
            } else if (this.type === tokTypes.ellipsis) {
              spreadStart = this.start
              exprList.push(this.parseParenItem(this.parseRestBinding()))

              // todo checkCommaAfterRest
              const checkCommaAfterRest = (() => {
                if (
                  this.isAmbientContext &&
                  this.match(tokTypes.comma) &&
                  this.lookaheadCharCode() === charCodes.rightParenthesis
                ) {
                  this.next()
                  return false
                } else {
                  return this.match(tokTypes.comma)
                }
              })()
              if (checkCommaAfterRest) {
                this.raise(this.start, 'Comma is not permitted after the rest element')
              }
              break
            } else {
              exprList.push(this.parseMaybeAssign(false, refDestructuringErrors, this.parseParenItem))
            }
          }
          let innerEndPos = this.lastTokEnd, innerEndLoc = this.lastTokEndLoc
          this.expect(tokTypes.parenR)

          // todo typescript shouldParseArrow
          const shouldParseArrow = ((): boolean => {
            if (this.match(tokTypes.colon)) {
              return exprList.every(expr => this.isAssignable(expr, true))
            }
            return !this.canInsertSemicolon()
          })()

          if (canBeArrow && shouldParseArrow && this.eat(tokTypes.arrow)) {
            this.checkPatternErrors(refDestructuringErrors, false)
            this.checkYieldAwaitInDefaultParams()
            this.yieldPos = oldYieldPos
            this.awaitPos = oldAwaitPos
            return this.parseParenArrowList(startPos, startLoc, exprList, forInit)
          }

          if (!exprList.length || lastIsComma) this.unexpected(this.lastTokStart)
          if (spreadStart) this.unexpected(spreadStart)
          this.checkExpressionErrors(refDestructuringErrors, true)
          this.yieldPos = oldYieldPos || this.yieldPos
          this.awaitPos = oldAwaitPos || this.awaitPos

          if (exprList.length > 1) {
            val = this.startNodeAt(innerStartPos, innerStartLoc)
            val.expressions = exprList
            this.finishNodeAt(val, 'SequenceExpression', innerEndPos, innerEndLoc)
          } else {
            val = exprList[0]
          }
        } else {
          val = this.parseParenExpression()
        }

        if (this.options.preserveParens) {
          let par = this.startNodeAt(startPos, startLoc)
          par.expression = val
          return this.finishNode(par, 'ParenthesizedExpression')
        } else {
          return val
        }
      }

      // todo we don't need this function, achieve this feature in
      //  parseSubscript
      // shouldParseAsyncArrow(): boolean {
      //   return this.match(tt.colon) || super.shouldParseAsyncArrow()
      // }

      parseSubscript(base, startPos, startLoc, noCalls, maybeAsyncArrow, optionalChained, forInit) {
        let optionalSupported = this.options.ecmaVersion >= 11
        let optional = optionalSupported && this.eat(tokTypes.questionDot)
        if (noCalls && optional) this.raise(this.lastTokStart, 'Optional chaining cannot appear in the callee of new expressions')

        let computed = this.eat(tokTypes.bracketL)
        if (computed || (optional && this.type !== tokTypes.parenL && this.type !== tokTypes.backQuote) || this.eat(tokTypes.dot)) {
          let node = this.startNodeAt(startPos, startLoc)
          node.object = base
          if (computed) {
            node.property = this.parseExpression()
            this.expect(tokTypes.bracketR)
          } else if (this.type === tokTypes.privateId && base.type !== 'Super') {
            node.property = this.parsePrivateIdent()
          } else {
            node.property = this.parseIdent(this.options.allowReserved !== 'never')
          }
          node.computed = !!computed
          if (optionalSupported) {
            node.optional = optional
          }
          base = this.finishNode(node, 'MemberExpression')
        } else if (!noCalls && this.eat(tokTypes.parenL)) {
          let refDestructuringErrors = new DestructuringErrors,
            oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos,
            oldAwaitIdentPos = this.awaitIdentPos
          this.yieldPos = 0
          this.awaitPos = 0
          this.awaitIdentPos = 0
          let exprList = this.parseExprList(tokTypes.parenR, this.options.ecmaVersion >= 8, false, refDestructuringErrors)

          // todo typescript shouldParseAsyncArrow
          const shouldParseAsyncArrow = ((): boolean => {
            return this.match(tokTypes.colon) || (
              !this.canInsertSemicolon() && this.eat(tokTypes.arrow)
            )
          })()
          if (
            maybeAsyncArrow && !optional && shouldParseAsyncArrow
          ) {
            this.checkPatternErrors(refDestructuringErrors, false)
            this.checkYieldAwaitInDefaultParams()
            if (this.awaitIdentPos > 0)
              this.raise(this.awaitIdentPos, 'Cannot use \'await\' as identifier inside an async function')
            this.yieldPos = oldYieldPos
            this.awaitPos = oldAwaitPos
            this.awaitIdentPos = oldAwaitIdentPos
            return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), exprList, true, forInit)
          }
          this.checkExpressionErrors(refDestructuringErrors, true)
          this.yieldPos = oldYieldPos || this.yieldPos
          this.awaitPos = oldAwaitPos || this.awaitPos
          this.awaitIdentPos = oldAwaitIdentPos || this.awaitIdentPos
          let node = this.startNodeAt(startPos, startLoc)
          node.callee = base
          node.arguments = exprList
          if (optionalSupported) {
            node.optional = optional
          }
          base = this.finishNode(node, 'CallExpression')
        } else if (this.type === tokTypes.backQuote) {
          if (optional || optionalChained) {
            this.raise(this.start, 'Optional chaining cannot appear in the tag of tagged template expressions')
          }
          let node = this.startNodeAt(startPos, startLoc)
          node.tag = base
          node.quasi = this.parseTemplate({ isTagged: true })
          base = this.finishNode(node, 'TaggedTemplateExpression')
        }
        return base
      }

      // todo we don't need this function. achieve this feature in
      //  parsePropertyValue
      // canHaveLeadingDecorator() {
      //   // Avoid unnecessary lookahead in checking for abstract class unless needed!
      //   return super.canHaveLeadingDecorator() || this.isAbstractClass()
      // }

      parsePropertyValue(prop, isPattern, isGenerator, isAsync, startPos, startLoc, refDestructuringErrors, containsEsc) {
        if ((isGenerator || isAsync) && this.type === tokTypes.colon)
          this.unexpected()

        if (this.eat(tokTypes.colon)) {
          prop.value = isPattern ? this.parseMaybeDefault(this.start, this.startLoc) : this.parseMaybeAssign(false, refDestructuringErrors)
          prop.kind = 'init'
        } else if (this.options.ecmaVersion >= 6 && this.type === tokTypes.parenL) {
          if (isPattern) this.unexpected()
          prop.kind = 'init'
          prop.method = true
          prop.value = this.parseMethod(isGenerator, isAsync)
        } else if (!isPattern && !containsEsc &&
          this.options.ecmaVersion >= 5 && !prop.computed && prop.key.type === 'Identifier' &&
          (prop.key.name === 'get' || prop.key.name === 'set') &&
          (this.type !== tokTypes.comma && this.type !== tokTypes.braceR && this.type !== tokTypes.eq)) {
          if (isGenerator || isAsync) this.unexpected()
          prop.kind = prop.key.name
          this.parsePropertyName(prop)
          prop.value = this.parseMethod(false)

          // here is getGetterSetterExpectedParamCount
          let paramCount = prop.kind === 'get' ? 0 : 1
          const firstParam = prop.value.params[0]
          const hasContextParam = firstParam && this.isThisParam(firstParam)
          paramCount = hasContextParam ? paramCount + 1 : paramCount
          // end

          if (prop.value.params.length !== paramCount) {
            let start = prop.value.start
            if (prop.kind === 'get')
              this.raiseRecoverable(start, 'getter should have no params')
            else
              this.raiseRecoverable(start, 'setter should have exactly one param')
          } else {
            if (prop.kind === 'set' && prop.value.params[0].type === 'RestElement')
              this.raiseRecoverable(prop.value.params[0].start, 'Setter cannot use rest params')
          }
        } else if (this.options.ecmaVersion >= 6 && !prop.computed && prop.key.type === 'Identifier') {
          if (isGenerator || isAsync) this.unexpected()
          this.checkUnreserved(prop.key)
          if (prop.key.name === 'await' && !this.awaitIdentPos)
            this.awaitIdentPos = startPos
          prop.kind = 'init'
          if (isPattern) {
            prop.value = this.parseMaybeDefault(startPos, startLoc, this.copyNode(prop.key))
          } else if (this.type === tokTypes.eq && refDestructuringErrors) {
            if (refDestructuringErrors.shorthandAssign < 0)
              refDestructuringErrors.shorthandAssign = this.start
            prop.value = this.parseMaybeDefault(startPos, startLoc, this.copyNode(prop.key))
          } else {
            prop.value = this.copyNode(prop.key)
          }
          prop.shorthand = true
        } else this.unexpected()
      }

      parseTryStatement(node) {
        this.next()
        node.block = this.parseBlock()
        node.handler = null
        if (this.type === tokTypes._catch) {
          let clause = this.startNode()
          this.next()
          if (this.eat(tokTypes.parenL)) {
            const param = this.parseBindingAtom()
            let simple = param.type === 'Identifier'
            this.enterScope(simple ? SCOPE_SIMPLE_CATCH : 0)
            this.checkLValPattern(param, simple ? BIND_SIMPLE_CATCH : BIND_LEXICAL)

            // start add ts support
            const type = this.tsTryParseTypeAnnotation()
            if (type) {
              param.typeAnnotation = type
              this.resetEndLocation(param)
            }
            // end

            clause.param = param
            this.expect(tt.parenR)
          } else {
            if (this.options.ecmaVersion < 10) this.unexpected()
            clause.param = null
            this.enterScope(0)
          }
          clause.body = this.parseBlock(false)
          this.exitScope()
          node.handler = this.finishNode(clause, 'CatchClause')
        }
        node.finalizer = this.eat(tokTypes._finally) ? this.parseBlock() : null
        if (!node.handler && !node.finalizer)
          this.raise(node.start, 'Missing catch or finally clause')
        return this.finishNode(node, 'TryStatement')
      }

      parseClass<T extends Class>(
        node: Class,
        isStatement: boolean
      ): Class {
        const oldInAbstractClass = this.inAbstractClass
        this.inAbstractClass = !!(node as any).abstract
        try {
          return this.originParseClass(node, isStatement)
        } finally {
          this.inAbstractClass = oldInAbstractClass
        }
      }

      parseMethod(
        isGenerator: boolean,
        isAsync: boolean,
        allowDirectSuper: boolean
      ) {
        const method = super.parseMethod(
          isGenerator,
          isAsync,
          allowDirectSuper
        )
        // @ts-expect-error todo(flow->ts) property not defined for all types in union
        if (method.abstract) {
          const hasBody = !!method.body
          if (hasBody) {
            const { key } = method
            this.raise(method.loc.start,
              TSErrors.AbstractMethodHasImplementation(
                key.type === 'Identifier' && !method.computed
                  ? key.name
                  : `[${this.input.slice(key.start, key.end)}]`
              )
            )
          }
        }
        return method
      }

      parse() {
        if (dts) {
          this.isAmbientContext = true
        }
        return super.parse()
      }

      parseExpressionAt() {
        if (dts) {
          this.isAmbientContext = true
        }
        return super.parseExpressionAt()
      }

      parseImportSpecifiers() {
        let nodes = [], first = true
        if (this.type === tokTypes.name) {
          // import defaultObj, { x, y as z } from '...'
          let node = this.startNode()
          node.local = this.parseIdent()
          this.checkLValSimple(node.local, BIND_LEXICAL)
          nodes.push(this.finishNode(node, 'ImportDefaultSpecifier'))
          if (!super.eat(tokTypes.comma)) return nodes
        }
        if (this.type === tokTypes.star) {
          let node = this.startNode()
          this.next()
          this.expectContextual('as')
          node.local = this.parseIdent()
          this.checkLValSimple(node.local, BIND_LEXICAL)
          nodes.push(this.finishNode(node, 'ImportNamespaceSpecifier'))
          return nodes
        }
        super.expect(tokTypes.braceL)
        while (!this.eat(tokTypes.braceR)) {
          if (!first) {
            this.expect(tokTypes.comma)
            if (this.afterTrailingComma(tokTypes.braceR)) {
              break
            }
          } else {
            first = false
          }

          let node = this.startNode()
          const isMaybeTypeOnly = this.ts_isContextual(tsTokenType.type)
          node.imported = this.parseModuleExportName()
          if (isMaybeTypeOnly) {
            this.parseTypeOnlyImportExportSpecifier(
              node,
              /* isImport */ true,
              node.importKind === 'type'
            )

            nodes.push(this.finishNode(node, 'ImportSpecifier'))
          } else {
            node.importKind = 'value'
            if (this.eatContextual('as')) {
              node.local = super.parseIdent()
            } else {
              this.checkUnreserved(node.imported)
              node.local = node.imported
            }
            this.checkLValSimple(node.local, BIND_LEXICAL)
            nodes.push(this.finishNode(node, 'ImportSpecifier'))
          }
        }
        return nodes
      }

      parseExportSpecifiers(exports, isInTypeExport = false) {
        let nodes = [], first = true
        // export { x, y as z } [from '...']
        this.expect(tokTypes.braceL)
        while (!this.eat(tokTypes.braceR)) {
          if (!first) {
            this.expect(tokTypes.comma)
            if (this.afterTrailingComma(tokTypes.braceR)) break
          } else {
            first = false
          }

          const isMaybeTypeOnly = this.ts_isContextual(tsTokenType.type)
          const isString = this.match(tokTypes.string)
          let node = this.startNode()
          this.checkExport(
            exports,
            node.exported,
            node.exported.start
          )

          if (!isString && isMaybeTypeOnly) {
            this.parseTypeOnlyImportExportSpecifier(
              node,
              /* isImport */ false,
              isInTypeExport
            )
            this.finishNode(node, 'ExportSpecifier')
          } else {
            node.exportKind = 'value'
            if (this.eatContextual(tsTokenType.as)) {
              node.exported = this.parseModuleExportName()
            } else if (isString) {
              node.exported = this.copyNode(node.local)
            } else if (!node.exported) {
              node.exported = this.copyNode(node.local)
            }
            this.finishNode(node, 'ExportSpecifier')
          }

          nodes.push(node)
        }
        return nodes
      }

      parseTypeOnlyImportExportSpecifier(
        node: any,
        isImport: boolean,
        isInTypeOnlyImportExport: boolean
      ): void {
        const leftOfAsKey = isImport ? 'imported' : 'local'
        const rightOfAsKey = isImport ? 'local' : 'exported'

        let leftOfAs = node[leftOfAsKey]
        let rightOfAs

        let hasTypeSpecifier = false
        let canParseAsKeyword = true

        const loc = leftOfAs.loc.start

        if (this.ts_isContextual(tsTokenType.as)) {
          // { type as ...? }
          const firstAs = this.parseIdent()
          if (this.isContextual(tsTokenType.as)) {
            // { type as as ...? }
            const secondAs = this.parseIdent()
            if (tokenIsKeywordOrIdentifier(this.type)) {
              // { type as as something }
              hasTypeSpecifier = true
              leftOfAs = firstAs
              rightOfAs = isImport
                ? this.parseIdent()
                : this.parseModuleExportName()
              canParseAsKeyword = false
            } else {
              // { type as as }
              rightOfAs = secondAs
              canParseAsKeyword = false
            }
          } else if (tokenIsKeywordOrIdentifier(this.type)) {
            // { type as something }
            canParseAsKeyword = false
            rightOfAs = isImport
              ? this.parseIdent()
              : this.parseModuleExportName()
          } else {
            // { type as }
            hasTypeSpecifier = true
            leftOfAs = firstAs
          }
        } else if (tokenIsKeywordOrIdentifier(this.type)) {
          // { type something ...? }
          hasTypeSpecifier = true
          if (isImport) {
            leftOfAs = super.parseIdent(true)
            if (!this.ts_isContextual(tsTokenType.as)) {
              this.checkUnreserved(leftOfAs)
            }
          } else {
            leftOfAs = this.parseModuleExportName()
          }
        }
        if (hasTypeSpecifier && isInTypeOnlyImportExport) {
          this.raise(
            loc,
            isImport
              ? TSErrors.TypeModifierIsUsedInTypeImports
              : TSErrors.TypeModifierIsUsedInTypeExports
          )
        }

        node[leftOfAsKey] = leftOfAs
        node[rightOfAsKey] = rightOfAs

        const kindKey = isImport ? 'importKind' : 'exportKind'
        node[kindKey] = hasTypeSpecifier ? 'type' : 'value'

        if (canParseAsKeyword && this.eatContextual(tsTokenType.as)) {
          node[rightOfAsKey] = isImport
            ? this.parseIdent()
            : this.parseModuleExportName()
        }
        if (!node[rightOfAsKey]) {
          node[rightOfAsKey] = this.copyNode(node[leftOfAsKey])
        }
        if (isImport) {
          this.checkLValSimple(node[rightOfAsKey], BIND_LEXICAL)
        }
      }

    } as typeof AcornParser
  }
}
