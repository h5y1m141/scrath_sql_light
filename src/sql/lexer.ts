import { Token, TokenType } from "./token.ts";

// ============================================================
// SQL Lexer (字句解析器)
// ============================================================

export class Lexer {
  private input: string;
  private position: number;
  private readPosition: number;
  private currentCharacter: string;

  constructor(input: string) {
    this.input = input;
    this.position = 0;
    this.readPosition = 0;
    this.currentCharacter = "";

    this.readChar();
  }

  nextToken(): Token {
    this.skipWhitespaceAndComments();

    let token: Token;

    switch (this.currentCharacter) {
      case "(":
        token = new Token(TokenType.LPAREN, this.currentCharacter);
        break;
      case ")":
        token = new Token(TokenType.RPAREN, this.currentCharacter);
        break;
      case ",":
        token = new Token(TokenType.COMMA, this.currentCharacter);
        break;
      case ";":
        token = new Token(TokenType.SEMICOLON, this.currentCharacter);
        break;
      case "*":
        token = new Token(TokenType.ASTERISK, this.currentCharacter);
        break;
      case "=":
        token = new Token(TokenType.EQ, this.currentCharacter);
        break;
      case "!":
        if (this.peekChar() === "=") {
          const ch = this.currentCharacter;
          this.readChar();
          token = new Token(TokenType.NEQ, ch + this.currentCharacter);
        } else {
          token = new Token(TokenType.ILLEGAL, this.currentCharacter);
        }
        break;
      case ">":
        if (this.peekChar() === "=") {
          const ch = this.currentCharacter;
          this.readChar();
          token = new Token(TokenType.GTE, ch + this.currentCharacter);
        } else {
          token = new Token(TokenType.GT, this.currentCharacter);
        }
        break;
      case "<":
        if (this.peekChar() === "=") {
          const ch = this.currentCharacter;
          this.readChar();
          token = new Token(TokenType.LTE, ch + this.currentCharacter);
        } else {
          token = new Token(TokenType.LT, this.currentCharacter);
        }
        break;
      case "'":
      case '"':
        return this.readString(this.currentCharacter);
      case "\0":
        token = new Token(TokenType.EOF, "");
        return token;
      default:
        if (this.isLetter(this.currentCharacter)) {
          const literal = this.readIdentifier();
          const type = Token.lookupIdent(literal);
          return new Token(type, literal);
        }
        if (this.isDigit(this.currentCharacter)) {
          const literal = this.readNumber();
          return new Token(TokenType.NUMBER, literal);
        }
        token = new Token(TokenType.ILLEGAL, this.currentCharacter);
        break;
    }

    this.readChar();
    return token;
  }

  // ============================================================
  // 文字読み取り
  // ============================================================

  private readChar(): void {
    this.currentCharacter =
      this.readPosition >= this.input.length
        ? "\0"
        : this.input[this.readPosition];
    this.position = this.readPosition;
    this.readPosition += 1;
  }

  private peekChar(): string {
    if (this.readPosition >= this.input.length) {
      return "\0";
    }
    return this.input[this.readPosition];
  }

  // ============================================================
  // 空白・コメントのスキップ
  // ============================================================

  private skipWhitespaceAndComments(): void {
    while (true) {
      this.skipWhitespace();
      if (
        this.currentCharacter === "-" &&
        this.peekChar() === "-"
      ) {
        this.skipLineComment();
      } else {
        break;
      }
    }
  }

  private skipWhitespace(): void {
    while (
      this.currentCharacter === " " ||
      this.currentCharacter === "\t" ||
      this.currentCharacter === "\n" ||
      this.currentCharacter === "\r"
    ) {
      this.readChar();
    }
  }

  private skipLineComment(): void {
    // '--' から行末までスキップ
    while (
      this.currentCharacter !== "\n" &&
      this.currentCharacter !== "\0"
    ) {
      this.readChar();
    }
    // 改行自体もスキップ
    if (this.currentCharacter === "\n") {
      this.readChar();
    }
  }

  // ============================================================
  // 識別子・数値・文字列の読み取り
  // ============================================================

  private readIdentifier(): string {
    const start = this.position;
    while (this.isLetter(this.currentCharacter) || this.isDigit(this.currentCharacter)) {
      this.readChar();
    }
    return this.input.substring(start, this.position);
  }

  private readNumber(): string {
    const start = this.position;
    while (this.isDigit(this.currentCharacter)) {
      this.readChar();
    }
    return this.input.substring(start, this.position);
  }

  private readString(quote: string): Token {
    // クォート文字をスキップ
    this.readChar();
    const start = this.position;
    while (
      this.currentCharacter !== quote &&
      this.currentCharacter !== "\0"
    ) {
      this.readChar();
    }
    const literal = this.input.substring(start, this.position);
    // 閉じクォートをスキップ
    if (this.currentCharacter === quote) {
      this.readChar();
    }
    return new Token(TokenType.STRING, literal);
  }

  // ============================================================
  // 文字判定
  // ============================================================

  private isLetter(ch: string): boolean {
    return (
      (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      ch === "_"
    );
  }

  private isDigit(ch: string): boolean {
    return ch >= "0" && ch <= "9";
  }
}
