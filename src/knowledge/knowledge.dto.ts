import { Transform } from "class-transformer"
import { ArrayMaxSize, IsArray, IsBoolean, IsDefined, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from "class-validator"

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value)
const emptyToNull = ({ value }: { value: unknown }) => (typeof value === "string" && value.trim() === "" ? null : typeof value === "string" ? value.trim() : value)
const DATE = /^\d{4}-\d{2}-\d{2}$/

export const FACT_TYPES = ["text", "long_text", "number", "usd", "date", "yes_no", "choice", "multi_choice"] as const
export const FACT_GROUPS = ["company", "asia", "regulatory", "outreach"] as const
export const BRAND_FIELDS = ["homeRevenueUsd", "revenueYear", "asianMarketsLive"] as const

/** The text fields sent with an uploaded file (multipart form). */
export class UploadDossierDto {
  @Transform(trim) @IsOptional() @IsString() @MaxLength(500) note?: string
}

/** "Mark as checked": an optional note and the date of the version that was read. */
export class CheckDossierDto {
  @Transform(trim) @IsOptional() @IsString() @MaxLength(1000) note?: string
  @Transform(emptyToNull) @IsOptional() @Matches(DATE, { message: "Enter the version date as a date." }) versionDate?: string | null
}

export class UncheckDossierDto {
  @Transform(trim) @IsString() @MinLength(3, { message: "Say why the check is taken back." }) @MaxLength(500) reason!: string
}

export class AddLinkDto {
  @Transform(trim) @IsString() @MinLength(4) @MaxLength(2000) url!: string
  @Transform(trim) @IsOptional() @IsString() @MaxLength(150) title?: string
}

export class ArchiveDossierDto {
  @Transform(trim) @IsString() @MinLength(3, { message: "Say why it's being archived." }) @MaxLength(500) reason!: string
}

/** A new version of one fact. */
export class SaveFactDto {
  @IsDefined({ message: "Enter the value." }) value!: unknown
  @Transform(trim) @IsString() @MinLength(3, { message: "Say where it comes from (dossier page, report or link)." }) @MaxLength(500) source!: string
  @Transform(emptyToNull) @IsOptional() @IsString() @MaxLength(40) sourceTierCode?: string | null
  @Matches(DATE, { message: "Use a date like 2026-03-31." }) evidenceDate!: string
  @Transform(emptyToNull) @IsOptional() @IsUUID() dossierId?: string | null
  @Transform(trim) @IsOptional() @IsString() @MaxLength(1000) note?: string
}

export class RejectFactDto {
  @IsString() @MaxLength(40) reasonCode!: string
  @Transform(trim) @IsString() @MinLength(3, { message: "Say what's wrong, in one line." }) @MaxLength(1000) reason!: string
}

export class VerifyManyDto {
  @IsArray() @ArrayMaxSize(200) @IsUUID("all", { each: true }) factIds!: string[]
}

export class CreateFactDefinitionDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) label!: string
  @IsIn(FACT_GROUPS) groupCode!: string
  @IsIn(FACT_TYPES) type!: string
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(80, { each: true }) options?: string[]
  @Transform(trim) @IsOptional() @IsString() @MaxLength(300) help?: string
  @IsOptional() @IsBoolean() required?: boolean
  @IsOptional() @IsInt() @Min(7) @Max(1825) refreshDays?: number
}

export class UpdateFactDefinitionDto {
  @Transform(trim) @IsOptional() @IsString() @MinLength(2) @MaxLength(80) label?: string
  @IsOptional() @IsIn(FACT_GROUPS) groupCode?: string
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(80, { each: true }) options?: string[]
  @Transform(trim) @IsOptional() @IsString() @MaxLength(300) help?: string
  @IsOptional() @IsBoolean() required?: boolean
  @IsOptional() @IsInt() @Min(7) @Max(1825) refreshDays?: number
  @IsOptional() @IsBoolean() active?: boolean
  @IsOptional() @IsInt() @Min(0) @Max(100000) sortOrder?: number
  /** Needed when a field becomes required or not, or is switched on or off. */
  @Transform(trim) @IsOptional() @IsString() @MaxLength(500) reason?: string
}
