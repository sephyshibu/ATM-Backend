import { Transform, Type } from "class-transformer"
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator"

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value)
const keepText = ({ value }: { value: unknown }) => (typeof value === "string" ? value.replace(/\r\n/g, "\n") : value)

export const TEMPLATE_KINDS = ["sequence", "booking"] as const
export type TemplateKind = (typeof TEMPLATE_KINDS)[number]

export class TemplateStepDto {
  @Transform(trim) @IsString() @MaxLength(200) subject!: string
  @Transform(keepText) @IsString() @MaxLength(10000) body!: string
  @Type(() => Number) @IsInt() @Min(0) @Max(60) delayDays!: number
}

/** The wording of a version: its steps, the back-up opening line and a note on what changed. */
export class TemplateWordingDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @ValidateNested({ each: true }) @Type(() => TemplateStepDto) steps!: TemplateStepDto[]
  @Transform(keepText) @IsOptional() @IsString() @MaxLength(1000) openingFallback?: string
  @Transform(trim) @IsOptional() @IsString() @MaxLength(500) note?: string
}

export class CreateTemplateDto extends TemplateWordingDto {
  @IsIn(TEMPLATE_KINDS) kind!: TemplateKind
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name!: string
  @Transform(trim) @IsOptional() @IsString() @MaxLength(500) description?: string
}

export class SaveDraftDto extends TemplateWordingDto {
  @Transform(trim) @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string
  @Transform(trim) @IsOptional() @IsString() @MaxLength(500) description?: string
}

export class SetRuleDto {
  @IsIn(TEMPLATE_KINDS) kind!: TemplateKind
  @Transform(trim) @IsOptional() @IsString() @MaxLength(60) categoryCode?: string
  @Transform(trim) @IsOptional() @IsString() @MaxLength(60) subCategoryCode?: string
  @Transform(trim) @IsOptional() @IsString() @MaxLength(60) routingCode?: string
  @IsUUID() templateId!: string
}

/** Preview of unsaved wording against a brand. */
export class PreviewDto extends TemplateWordingDto {
  @IsUUID() brandId!: string
}
