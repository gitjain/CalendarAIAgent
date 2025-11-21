const { spawn } = require('child_process');
const { EventEmitter } = require('events');

/**
 * MCP Meal Planning Client
 * Communicates with the official spoonacular-mcp server via JSON-RPC 2.0
 * Generates structured meal plans with recipes, nutrition data, and images
 */
class MCPMealPlanningClient extends EventEmitter {
  constructor() {
    super();
    this.spoonacularApiKey = process.env.SPOONACULAR_API_KEY || process.env.SPOONACULAR_KEY;
    this.mcpServerCommand = 'spoonacular-mcp';
    this.requestId = 0;
  }

  /**
   * Send a JSON-RPC 2.0 request to the MCP server
   */
  async sendMCPRequest(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.spoonacularApiKey) {
        return reject(new Error('SPOONACULAR_API_KEY or SPOONACULAR_KEY environment variable not set'));
      }

      this.requestId++;
      const request = {
        jsonrpc: '2.0',
        id: this.requestId,
        method: method,
        params: params
      };

      console.log(`🍽️ [MCP] Sending request: ${method}`);

      const child = spawn(this.mcpServerCommand, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          SPOONACULAR_API_KEY: this.spoonacularApiKey
        }
      });

      let stdout = '';
      let stderr = '';
      let responseParsed = false;

      child.stdin.write(JSON.stringify(request) + '\n');
      child.stdin.end();

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        const stderrData = data.toString();
        stderr += stderrData;
        // Filter out the "running on stdio" message
        if (!stderrData.includes('running on stdio')) {
          console.error('[MCP stderr]:', stderrData);
        }
      });

      child.on('error', (error) => {
        console.error('❌ [MCP] Process error:', error.message);
        if (error.code === 'ENOENT') {
          reject(new Error('spoonacular-mcp not found. Please install it: npm install -g spoonacular-mcp'));
        } else {
          reject(new Error(`MCP server error: ${error.message}`));
        }
      });

      child.on('close', (code) => {
        if (responseParsed) return;

        if (code !== 0) {
          console.error('❌ [MCP] Server exited with code:', code);
          if (stderr.includes('SPOONACULAR_API_KEY')) {
            return reject(new Error('Spoonacular API key is missing or invalid'));
          } else if (stderr.includes('rate limit') || stderr.includes('429')) {
            return reject(new Error('Spoonacular API rate limit exceeded'));
          } else if (stderr) {
            return reject(new Error(`MCP server error: ${stderr.substring(0, 200)}`));
          }
          return reject(new Error(`MCP server exited with code ${code}`));
        }

        try {
          // Parse the JSON-RPC response (may have multiple lines, we want the last JSON)
          const lines = stdout.trim().split('\n');
          let response = null;
          
          // Find the JSON-RPC response (skip server startup messages)
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const parsed = JSON.parse(lines[i]);
              if (parsed.jsonrpc === '2.0' && parsed.id === this.requestId) {
                response = parsed;
                break;
              }
            } catch (e) {
              // Not JSON, skip
            }
          }

          if (!response) {
            return reject(new Error('No valid JSON-RPC response received'));
          }

          responseParsed = true;

          if (response.error) {
            console.error('❌ [MCP] Server returned error:', response.error);
            return reject(new Error(response.error.message || 'MCP server error'));
          }

          if (!response.result) {
            return reject(new Error('MCP server returned no result'));
          }

          console.log('✅ [MCP] Request successful');
          resolve(response.result);
        } catch (parseError) {
          console.error('❌ [MCP] Failed to parse response:', parseError.message);
          console.error('Raw output:', stdout);
          reject(new Error(`Failed to parse MCP response: ${parseError.message}`));
        }
      });
    });
  }

  /**
   * Search for recipes using MCP server
   */
  async searchRecipes({ query, number = 10, diet = '', intolerances = '', type = '', cuisine = '' }) {
    const params = {
      name: 'search_recipes',
      arguments: {
        query: query,
        number: number
      }
    };

    if (diet) params.arguments.diet = diet;
    if (intolerances) params.arguments.intolerances = intolerances;
    if (type) params.arguments.type = type;
    if (cuisine) params.arguments.cuisine = cuisine;

    const result = await this.sendMCPRequest('tools/call', params);
    return result.content && result.content[0] ? JSON.parse(result.content[0].text) : null;
  }

  /**
   * Get detailed recipe information
   */
  async getRecipeInformation(recipeId, includeNutrition = true) {
    const result = await this.sendMCPRequest('tools/call', {
      name: 'get_recipe_information',
      arguments: {
        id: recipeId,
        includeNutrition: includeNutrition
      }
    });
    return result.content && result.content[0] ? JSON.parse(result.content[0].text) : null;
  }

  /**
   * Get random recipes
   */
  async getRandomRecipes({ number = 7, tags = '' }) {
    const result = await this.sendMCPRequest('tools/call', {
      name: 'get_random_recipes',
      arguments: {
        number: number,
        tags: tags
      }
    });
    return result.content && result.content[0] ? JSON.parse(result.content[0].text) : null;
  }

  /**
   * Build a meal plan from recipes
   */
  buildMealPlan(recipes, preferences) {
    const meals = recipes.map((recipe, index) => ({
      id: recipe.id,
      title: recipe.title,
      readyInMinutes: recipe.readyInMinutes,
      servings: recipe.servings,
      sourceUrl: recipe.sourceUrl || recipe.spoonacularSourceUrl,
      image: recipe.image,
      day: Math.floor(index / 3) + 1, // 3 meals per day
      mealType: ['breakfast', 'lunch', 'dinner'][index % 3],
      summary: recipe.summary ? recipe.summary.replace(/<[^>]*>/g, '').substring(0, 200) : ''
    }));

    // Calculate total nutrients if available
    let totalNutrients = null;
    if (recipes.some(r => r.nutrition)) {
      totalNutrients = {
        calories: 0,
        protein: 0,
        fat: 0,
        carbohydrates: 0
      };

      recipes.forEach(recipe => {
        if (recipe.nutrition && recipe.nutrition.nutrients) {
          const nutrients = recipe.nutrition.nutrients;
          const calories = nutrients.find(n => n.name === 'Calories');
          const protein = nutrients.find(n => n.name === 'Protein');
          const fat = nutrients.find(n => n.name === 'Fat');
          const carbs = nutrients.find(n => n.name === 'Carbohydrates');

          if (calories) totalNutrients.calories += calories.amount;
          if (protein) totalNutrients.protein += protein.amount;
          if (fat) totalNutrients.fat += fat.amount;
          if (carbs) totalNutrients.carbohydrates += carbs.amount;
        }
      });
    }

    return {
      meals: meals,
      nutrients: totalNutrients
    };
  }

  /**
   * Format meal plan as plain text
   */
  formatMealPlanText(mealPlan, preferences) {
    let text = '🍽️ WEEKLY MEAL PLAN\n\n';
    
    if (preferences.diet) {
      text += `Diet: ${preferences.diet}\n`;
    }
    if (preferences.targetCalories) {
      text += `Target Calories: ${preferences.targetCalories}/day\n`;
    }
    if (preferences.exclude) {
      text += `Exclusions: ${preferences.exclude}\n`;
    }
    text += '\n';

    // Group meals by day
    const mealsByDay = {};
    mealPlan.meals.forEach(meal => {
      if (!mealsByDay[meal.day]) {
        mealsByDay[meal.day] = [];
      }
      mealsByDay[meal.day].push(meal);
    });

    Object.keys(mealsByDay).sort((a, b) => parseInt(a) - parseInt(b)).forEach(day => {
      text += `DAY ${day}\n`;
      text += '─'.repeat(40) + '\n';
      
      mealsByDay[day].forEach(meal => {
        text += `\n${meal.mealType.toUpperCase()}: ${meal.title}\n`;
        text += `  ⏱️  Ready in: ${meal.readyInMinutes || 'N/A'} minutes\n`;
        text += `  🍽️  Servings: ${meal.servings || 'N/A'}\n`;
        if (meal.sourceUrl) {
          text += `  🔗 Recipe: ${meal.sourceUrl}\n`;
        }
      });
      
      text += '\n';
    });

    if (mealPlan.nutrients) {
      text += '\n' + '═'.repeat(40) + '\n';
      text += 'NUTRITION SUMMARY (Total for all meals)\n';
      text += '─'.repeat(40) + '\n';
      text += `Calories: ${Math.round(mealPlan.nutrients.calories)}\n`;
      text += `Protein: ${Math.round(mealPlan.nutrients.protein)}g\n`;
      text += `Fat: ${Math.round(mealPlan.nutrients.fat)}g\n`;
      text += `Carbohydrates: ${Math.round(mealPlan.nutrients.carbohydrates)}g\n`;
    }

    return text;
  }

  /**
   * Main method: Generate meal plan for an event
   * This is called by the event analyzer when a meal prep event is detected
   */
  async generateMealPlanForEvent(event, tokens, preferences = {}) {
    try {
      const userPreferences = {
        days: preferences.days !== undefined ? preferences.days : 7,
        familySize: preferences.familySize || preferences.people || 2, // Default to 2 people
        targetCalories: preferences.targetCalories !== undefined ? preferences.targetCalories : 2000,
        diet: preferences.diet || '',
        exclude: preferences.exclude || '',
        eventDate: event.date || event.start?.dateTime || event.start?.date || new Date().toISOString()
      };

      console.log(`🍽️ [MCP] Generating meal plan for event: "${event.title}"`);
      console.log(`   Preferences (with defaults):`, JSON.stringify(userPreferences));

      // Calculate number of recipes needed (3 meals per day)
      const numberOfRecipes = userPreferences.days * 3;

      // Build search tags based on preferences
      let tags = [];
      if (userPreferences.diet) {
        tags.push(userPreferences.diet);
      }

      // Get random recipes with filters
      console.log(`🔍 [MCP] Fetching ${numberOfRecipes} recipes...`);
      const recipesResponse = await this.getRandomRecipes({
        number: numberOfRecipes,
        tags: tags.join(',')
      });

      console.log(`🔍 [MCP] Raw response type:`, typeof recipesResponse);
      console.log(`🔍 [MCP] Response preview:`, JSON.stringify(recipesResponse).substring(0, 200));

      // Check if response is an error
      if (recipesResponse && typeof recipesResponse === 'string') {
        throw new Error(`Spoonacular returned error: ${recipesResponse.substring(0, 100)}`);
      }

      if (!recipesResponse || !recipesResponse.recipes || recipesResponse.recipes.length === 0) {
        throw new Error('No recipes found matching your criteria');
      }

      const recipes = recipesResponse.recipes;
      console.log(`✅ [MCP] Found ${recipes.length} recipes`);

      // Get detailed information for each recipe (including nutrition)
      console.log(`📊 [MCP] Fetching detailed recipe information...`);
      const detailedRecipes = await Promise.all(
        recipes.slice(0, numberOfRecipes).map(recipe => 
          this.getRecipeInformation(recipe.id, true).catch(err => {
            console.warn(`⚠️  Failed to get details for recipe ${recipe.id}:`, err.message);
            return recipe; // Use basic recipe if detailed fetch fails
          })
        )
      );

      // Build meal plan structure
      const mealPlan = this.buildMealPlan(detailedRecipes, userPreferences);

      // Format as text
      const formattedText = this.formatMealPlanText(mealPlan, userPreferences);

      console.log(`✅ [MCP] Meal plan generated successfully`);

      return {
        success: true,
        mealPlan: mealPlan,
        preferences: userPreferences,
        formattedText: formattedText
      };
    } catch (error) {
      console.error('❌ [MCP] Error in generateMealPlanForEvent:', error.message);
      throw error;
    }
  }
}

module.exports = new MCPMealPlanningClient();
