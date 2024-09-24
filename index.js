import { GraphQLClient } from 'graphql-request';
import dotenv from 'dotenv';
import fs from 'fs';

// Load environment variables from a .env file
dotenv.config();

// Function to display usage information
function displayHelp() {
  console.log(`
Usage: npm start -- [options] [quarter]

Options:
  -h           Display this help message
  -o <file>    Specify the output file name

Arguments:
  quarter      Specify the quarter in the format Q[1-4]YYYY (e.g., Q32024)
               If not provided, the current quarter will be used

Examples:
  npm start -- -h
  npm start -- Q32024
  npm start -- -o custom_output.csv
  npm start -- Q32024 -o custom_output.csv

Description:
  This script fetches team cycle data from Linear and outputs it to a CSV file.
  If no output file is specified, it will use the default name: team_cycle_data_[quarter].csv
  `);
  process.exit(0);
}

// Check if the API key is set
if (!process.env.LINEAR_API_KEY) {
  console.error('Error: LINEAR_API_KEY is not set in the environment variables.');
  console.error('Please set the LINEAR_API_KEY environment variable or add it to your .env file.');
  process.exit(1);
}

const client = new GraphQLClient('https://api.linear.app/graphql', {
  headers: {
    Authorization: `${process.env.LINEAR_API_KEY}`,
  },
});

// Function to get the current quarter and year
function getCurrentQuarterYear() {
  const now = new Date();
  const quarter = Math.floor(now.getMonth() / 3) + 1;
  const year = now.getFullYear();
  return { quarter, year };
}

// Parse command line arguments
let quarter, year, arg, outputFile;
const args = process.argv.slice(2);

// Function to parse arguments
function parseArgs(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-h') {
      displayHelp();
    } else if (args[i] === '-o') {
      if (i + 1 < args.length) {
        outputFile = args[i + 1];
        i++; // Skip the next argument as it's the filename
      } else {
        console.error('Error: -o option requires a filename argument.');
        process.exit(1);
      }
    } else if (/^Q[1-4]\d{4}$/.test(args[i])) {
      arg = args[i];
      quarter = parseInt(arg[1]);
      year = parseInt(arg.slice(2));
    }
  }
}

// First, try to parse arguments as is
parseArgs(args);

// If no arguments were recognized, try parsing without the first argument
// This handles the case when npm adds its own arguments
if (!quarter && !year && !outputFile && args.length > 1) {
  parseArgs(args.slice(1));
}

// If quarter and year are not set, use current quarter
if (!quarter || !year) {
  const current = getCurrentQuarterYear();
  quarter = current.quarter;
  year = current.year;
  arg = `Q${quarter}${year}`;
  console.log(`No valid quarter argument provided. Using current quarter: ${arg}`);
}

// If output file is not specified, use default name
if (!outputFile) {
  outputFile = `team_cycle_data_${arg}.csv`;
  console.log(`No output file specified. Using default: ${outputFile}`);
}

// Calculate start and end dates
const startDate = new Date(year, (quarter - 1) * 3, 1);
const endDate = new Date(year, quarter * 3, 0);

// Format dates for GraphQL query (YYYY-MM-DD format)
const formattedStartDate = startDate.toISOString().split('T')[0];
const formattedEndDate = endDate.toISOString().split('T')[0];

const teamsQuery = `
  query {
    teams(filter: { name: { startsWith: "Squad" } }) {
      nodes {
        id
        name
        cycles(
          filter: { 
            endsAt: { 
              gte: "${formattedStartDate}",
              lt: "${formattedEndDate}"
            }
          }
        ) {
          nodes {
            id
            number
            startsAt
            endsAt
            issueCountHistory
            completedIssueCountHistory
          }
        }
      }
    }
  }
`;

// need a second query because the complexity is too high to include in first query and linear rejects the request
const scopeChangeQuery = `
  query {
    teams(filter: { name: { startsWith: "Squad" } }) {
      nodes {
        id
        cycles(
          filter: { 
            endsAt: { 
              gte: "${formattedStartDate}",
              lt: "${formattedEndDate}"
            }
          }
        ) {
          nodes {
            id
            scopeHistory
          }
        }
      }
    }
  }
`;

const main = async () => {
  try {
    const [teamsData, scopeChangeData] = await Promise.all([
      client.request(teamsQuery),
      client.request(scopeChangeQuery)
    ]);

    const teams = teamsData.teams.nodes;
    const scopeChanges = new Map();

    // Process scope changes
    scopeChangeData.teams.nodes.forEach(team => {
      team.cycles.nodes.forEach(cycle => {
        const initialScope = cycle.scopeHistory[0] || 0;
        const finalScope = cycle.scopeHistory[cycle.scopeHistory.length - 1] || 0;
        const scopeChange = finalScope - initialScope;
        scopeChanges.set(cycle.id, scopeChange);
      });
    });
    
    const currentDate = new Date();
    
    let rows = [];
    
    teams.forEach(team => {
      if (team.name === "Squad Enablement") return;

      team.cycles.nodes.forEach(cycle => {
        if (new Date(cycle.endsAt) > currentDate) return;

        const totalIssueCount = cycle.issueCountHistory[cycle.issueCountHistory.length - 1];
        const completedIssueCount = cycle.completedIssueCountHistory[cycle.completedIssueCountHistory.length - 1];
        const scopeChange = scopeChanges.get(cycle.id) || 0;
        
        const completionPercentage = totalIssueCount > 0 
          ? Math.round((completedIssueCount / totalIssueCount) * 100)
          : 0;
        
        const capacityAccuracy = (totalIssueCount - scopeChange) !== 0
          ? Math.round((completedIssueCount / (totalIssueCount - scopeChange)) * 100)
          : 'N/A';
        
        const startDate = new Date(cycle.startsAt).toISOString().split('T')[0];
        const endDate = new Date(cycle.endsAt).toISOString().split('T')[0];
        
        rows.push({
          team: team.name,
          cycleNumber: cycle.number,
          startDate,
          endDate,
          totalIssues: totalIssueCount,
          completedIssues: completedIssueCount,
          completionPercentage,
          scopeChange,
          capacityAccuracy
        });
      });
    });
    
    rows.sort((a, b) => {
      if (a.team !== b.team) return a.team.localeCompare(b.team);
      return b.cycleNumber - a.cycleNumber;
    });
    
    const csvRows = rows.map(row => 
      `${row.team},${row.cycleNumber},${row.startDate},${row.endDate},${row.totalIssues},${row.completedIssues},${row.completionPercentage},${row.scopeChange},${row.capacityAccuracy}`
    );
    
    csvRows.unshift('Team,Cycle Number,Cycle Start Date,Cycle End Date,Total Issues,Completed Issues,Completion Percentage,Scope Change,Capacity Accuracy (%)');
    
    const csvContent = csvRows.join('\n');
    
    fs.writeFileSync(outputFile, csvContent);
    console.log(`CSV file has been written successfully: ${outputFile}`);
    
  } catch (error) {
    if (error.response && error.response.errors) {
      console.error('GraphQL Errors:');
      error.response.errors.forEach((err, index) => {
        console.error(`Error ${index + 1}:`, err.message);
      });
    } else {
      console.error('Error:', error.message);
    }
    process.exit(1);
  }
};

main();
