import { Transform } from "class-transformer"
import { IsDefined, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength } from "class-validator"

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value)

export class UpdateSettingDto {
  @IsDefined()
  value!: unknown

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string
}

export class CreateListValueDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: "Give it a name." })
  @MaxLength(120)
  label!: string

  /** Optional: made from the label when left out. Upper-case letters, digits and _. */
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toUpperCase() : value))
  @IsOptional()
  @Matches(/^[A-Z0-9_]{1,40}$/, { message: "Codes use capital letters, digits and _ (up to 40)." })
  code?: string

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string

  @IsOptional()
  @IsUUID()
  parentId?: string
}

export class UpdateListValueDto {
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MinLength(1, { message: "Give it a name." })
  @MaxLength(120)
  label?: string

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number
}
