import { Transform, Type } from "class-transformer"
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator"

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value)

export const QUESTION_TYPES = ["text", "textarea", "phone", "email", "url", "number", "yesno", "select"] as const
export const CONFERENCING = ["GOOGLE_MEET", "CUSTOM_LINK", "NONE"] as const

/** One question on the booking form. Name and email are always asked separately. */
export class QuestionDto {
  @Transform(trim) @IsOptional() @IsString() @MaxLength(60) id?: string
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(200) label!: string
  @IsIn(QUESTION_TYPES) type!: (typeof QUESTION_TYPES)[number]
  @IsBoolean() required!: boolean
  @IsOptional() @IsArray() @ArrayMaxSize(25) @IsString({ each: true }) @MaxLength(200, { each: true }) options?: string[]
  @Transform(trim) @IsOptional() @IsString() @MaxLength(300) help?: string
}

export class WindowDto {
  @Type(() => Number) @IsInt() @Min(0) @Max(6) weekday!: number
  @Type(() => Number) @IsInt() @Min(0) @Max(1439) startMinute!: number
  @Type(() => Number) @IsInt() @Min(1) @Max(1440) endMinute!: number
}

export class EventTypeDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name!: string
  @Transform(trim) @IsOptional() @IsString() @MaxLength(2000) description?: string
  @Type(() => Number) @IsInt() @Min(5) @Max(480) durationMins!: number
  @IsIn(CONFERENCING) conferencing!: (typeof CONFERENCING)[number]
  @Transform(trim) @IsOptional() @IsString() @MaxLength(500) customLink?: string
  @Type(() => Number) @IsInt() @Min(0) @Max(240) bufferBeforeMins!: number
  @Type(() => Number) @IsInt() @Min(0) @Max(240) bufferAfterMins!: number
  @Type(() => Number) @IsInt() @Min(0) @Max(43200) minNoticeMins!: number
  @Type(() => Number) @IsInt() @Min(1) @Max(365) dateRangeDays!: number
  @Type(() => Number) @IsInt() @Min(5) @Max(240) slotIncrementMins!: number
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) maxPerDay?: number | null
  @Transform(trim) @IsString() @MaxLength(80) timezone!: string
  @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => QuestionDto) questions!: QuestionDto[]
  @IsArray() @ArrayMaxSize(70) @ValidateNested({ each: true }) @Type(() => WindowDto) availability!: WindowDto[]
  @IsOptional() @IsBoolean() active?: boolean
}

/** A booking from the public page. `answers` holds the form, keyed by question id. */
export class BookDto {
  @Transform(trim) @IsString() @MinLength(1, { message: "Your name is required." }) @MaxLength(200) name!: string
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value)) @IsEmail({}, { message: "Enter a valid email address." }) @MaxLength(320) email!: string
  @IsString() @MaxLength(40) start!: string
  @Transform(trim) @IsOptional() @IsString() @MaxLength(80) timezone?: string
  @IsOptional() @IsObject() answers?: Record<string, unknown>
}

export class RescheduleDto {
  @IsString() @MaxLength(40) start!: string
}

export class CancelDto {
  @Transform(trim) @IsOptional() @IsString() @MaxLength(500) reason?: string
}
