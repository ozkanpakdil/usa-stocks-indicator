export function cleanCompanyName(name: string): string {
  if (!name) return "";
  let cleaned = name.toUpperCase();
  
  // Remove common suffixes
  const suffixes = [
    ", INC.", ", INC", " INC.", " INC",
    ", LLC.", ", LLC", " LLC.", " LLC",
    ", CORP.", ", CORP", " CORP.", " CORP",
    ", CORPORATION", " CORPORATION",
    ", CO.", ", CO", " CO.", " CO",
    ", COMPANY", " COMPANY",
    ", LTD.", ", LTD", " LTD.", " LTD",
    ", LIMITED", " LIMITED",
    " P.C.", " PC",
    " L.P.", " LP"
  ];

  for (const suffix of suffixes) {
    if (cleaned.endsWith(suffix)) {
      cleaned = cleaned.slice(0, -suffix.length);
    }
  }

  // Remove common symbols and extra spaces
  cleaned = cleaned.replace(/[^A-Z0-9 ]/g, " ");
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  return cleaned;
}

export async function searchTicker(companyName: string) {
  let cleanedName = cleanCompanyName(companyName);
  
  // Universities and government entities are not stocks
  const blacklist = ["UNIVERSITY", "INSTITUTE OF TECHNOLOGY", "DEPARTMENT OF", "STATE OF", "CITY OF", "REGENTS OF"];
  for (const item of blacklist) {
    if (cleanedName.includes(item)) return null;
  }

  const trySearch = async (query: string) => {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}`;
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const data = await response.json();
      const quotes = data.quotes || [];
      // Strictly filter for US Equities to avoid indices and private companies
      const usQuotes = quotes.filter((q: any) => 
        ["NYQ", "NMS", "NAS", "NYS", "ASE", "PCX"].includes(q.exchange) &&
        q.quoteType === "EQUITY"
      );
      return usQuotes[0] || null;
    } catch (e) {
      return null;
    }
  };

  // Try original cleaned name
  let result = await trySearch(cleanedName);
  if (result) return result;

  // If not found and has multiple words, try removing the last word if it looks like a generic descriptor
  const generics = ["SYSTEMS", "SERVICES", "SOLUTIONS", "TECHNOLOGIES", "FEDERAL", "INTERNATIONAL", "NORTH", "AMERICA", "GROUP", "HOLDINGS", "CORPORATION", "COMPANY", "INC", "LLC"];
  let words = cleanedName.split(" ");
  
  while (words.length > 1) {
    const lastWord = words[words.length - 1];
    if (generics.includes(lastWord) || words.length > 2) {
      words.pop();
      const nextQuery = words.join(" ");
      result = await trySearch(nextQuery);
      if (result) return result;
    } else {
      break;
    }
  }

  return null;
}
