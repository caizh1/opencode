import type { ReferenceDocument } from "./types"

export type RecipeMatchResult = {
  matched: boolean
  score: number
}

export type DocumentRecipe = {
  id: string
  name: string
  match(input: { question: string; documents: ReferenceDocument[] }): Promise<RecipeMatchResult>
}

export class DocumentRecipeRegistry {
  private readonly recipes: DocumentRecipe[] = []

  register(recipe: DocumentRecipe) {
    this.recipes.push(recipe)
  }

  async select(input: { question: string; documents: ReferenceDocument[] }) {
    const matches = await Promise.all(this.recipes.map(async (recipe) => ({ recipe, match: await recipe.match(input) })))
    return matches
      .filter((item) => item.match.matched)
      .sort((left, right) => right.match.score - left.match.score)[0]?.recipe
  }
}
