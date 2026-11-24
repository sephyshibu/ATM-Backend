import { Transform } from "class-transformer"
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from "class-validator"

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value)
const emptyToNull = ({ value }: { value: unknown }) => (typeof value === "string" && value.trim() === "" ? null : value)
const DATE = /^\d{4}-\d{2}-\d{2}$/

export class OpenLeadDto {
  @Transform(emptyToNull) @IsOptional() @IsUUID() personId?: string | null
  @IsOptional() @IsIn(["outbound", "enquiry", "referral", "investor"]) source?: string
}

/** A person's move. The journey says which of reasonCode, reason and until it needs. */
export class MoveDto {
  @IsString() @MaxLength(60) moveKey!: string
  @Transform(emptyToNull) @IsOptional() @IsString() @MaxLength(40) reasonCode?: string | null
  @Transform(trim) @IsOptional() @IsString() @MaxLength(1000) reason?: string
  @Transform(emptyToNull) @IsOptional() @Matches(DATE, { message: "Use a date like 2026-03-31." }) until?: string | null
  /** Deciding against the gates' recommendation: a reason from Lists → Override reasons, and one line. */
  @Transform(emptyToNull) @IsOptional() @IsString() @MaxLength(40) overrideReasonCode?: string | null
  @Transform(trim) @IsOptional() @IsString() @MaxLength(1000) overrideReason?: string
}

export class BulkMoveDto extends MoveDto {
  @IsArray() @ArrayMaxSize(500) @IsUUID("all", { each: true }) leadIds!: string[]
}

export class EventDto {
  @IsString() @MaxLength(40) type!: string
  /** The event's own id from lemlist or the booking tool; the same id is applied once. */
  @Transform(trim) @IsOptional() @IsString() @MaxLength(200) eventKey?: string
  @Transform(trim) @IsOptional() @IsString() @MaxLength(500) note?: string
}

export class OverrideDto {
  @IsString() @MaxLength(30) stage!: string
  @Transform(emptyToNull) @IsOptional() @IsString() @MaxLength(30) lane?: string | null
  @Transform(emptyToNull) @IsOptional() @Matches(DATE, { message: "Use a date like 2026-03-31." }) until?: string | null
  @Transform(trim) @IsString() @MaxLength(1000) reason!: string
}

export class UndoDto {
  @Transform(trim) @IsString() @MaxLength(1000) reason!: string
}

export class SetPersonDto {
  @Transform(emptyToNull) @IsOptional() @IsUUID() personId?: string | null
}

export class SetGateDto {
  @IsOptional() @IsIn(["pass", "fail", "unknown"]) value?: string
  /** The checklist tick: false = not needed for this brand (needs a reason). */
  @IsOptional() @IsBoolean() applies?: boolean
  @Transform(trim) @IsOptional() @IsString() @MaxLength(500) evidence?: string
  @Transform(emptyToNull) @IsOptional() @IsString() @MaxLength(40) reasonCode?: string | null
  @Transform(trim) @IsOptional() @IsString() @MaxLength(1000) reason?: string
}

export class UpdateGateDefinitionDto {
  @Transform(trim) @IsOptional() @IsString() @MaxLength(80) name?: string
  @Transform(trim) @IsOptional() @IsString() @MaxLength(500) checks?: string
  @IsOptional() @IsBoolean() active?: boolean
  @Transform(trim) @IsOptional() @IsString() @MaxLength(500) reason?: string
}
