const axios = require("axios");
const cheerio = require("cheerio");

axios.get("https://www.instagram.com/juli4.fre/")
    .then(res => {
        console.log(res.data);
    })
    .catch(err => {
        console.log("Error while getting the page.");
        console.error(err.message);
    });
