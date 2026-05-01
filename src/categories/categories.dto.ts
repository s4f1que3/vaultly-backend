import { IsString, MinLength } from 'class-validator';

export class CreateCategoryDto {
  @IsString()
  @MinLength(2, { message: 'Name must be at least 2 characters' })
  label: string;

  @IsString()
  emoji: string;
}
