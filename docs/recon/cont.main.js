// JavaScript Document
$(function(){	
    'use strict';
	$(".dropDown").hover(function(){
		$(this).find(".dropDown-menu").stop().show(500);	
	  },function(){
			$(this).find(".dropDown-menu").stop().hide(500);
			 }); 
    
	$(".dropDown").click(function(event){
		event.stopPropagation();
		$(this).find(".dropDown-list").toggle(300);
	});
	$(".tree>li>a").click(function(){
	    $(this).parents("li").toggleClass("active").siblings().removeClass("active");
		$(this).parents().siblings().find(".tree-second").hide();
		$(this).siblings(".tree-second").toggle();
	  });
    $(".tree-second>li>a").click(function(){
        $(this).parents("li").addClass("active").siblings().removeClass("active");		
	}); 
	$("#treeBox").click(function(event){
		event.stopPropagation();
		$(this).toggleClass("active");
		$(this).find("#treeShowbox").show();
	});
	 $(document).click(function() { 
	   $(".dropDown-list").slideUp();
	   $("#treeShowbox").slideUp();
	   $("#treeBox").removeClass("active");
	   }); 		 
function banner(){
  var size=$(".bannerBox .bannerImg li").size();
  for(var i=1;i<=size;i++){
	  var li="<li></li>";
	  $(".bannerBox .tip").append(li);
  }
  $(".bannerImg li").eq(0).show();
  $(".bannerBox .tip li").eq(0).addClass("active");
  $(".bannerBox .tip li").mouseover(function(){
	  $(this).addClass("active").siblings().removeClass("active");
	  var index=$(this).index();
	  i=index;
	  $(".bannerBox .bannerImg li").eq(index).stop().fadeIn(500).siblings().stop().fadeOut(500);
	  });
  var i=0;
  var t=setInterval(move,3000);
 function move(){
		i++;
		if(i==size){
			i=0;
			}
		$(".bannerBox .tip li").eq(i).addClass("active").siblings().removeClass("active");
		$(".bannerBox .bannerImg li").eq(i).fadeIn(500).siblings().fadeOut(500);
		};
 function moveL(){
		i--;
		if(i==-1){
			i=size-1;
			}
		$(".bannerBox .tip li").eq(i).addClass("active").siblings().removeClass("active");
		$(".bannerBox .bannerImg li").eq(i).fadeIn(500).siblings().fadeOut(500);
		};
 $(".bannerBox").hover(function(){  //hover有两个状态，移入和移除
		clearInterval(t);
		},function(){
			t=setInterval(move,3000);
			});	
	}
	banner();
	
$(".caname").click(function() { 
		var td = $(this); 
		var txt = td.text(); 
		var input = $("<input type='text'  class='form-sm' value='" + txt + "'/>"); 
		td.html(input); 
		input.click(function() { return false; }); 
		input.trigger("focus"); 
		input.blur(function() { 
		var newtxt = $(this).val(); 
		if (newtxt !== txt) { 
		td.html(newtxt); 
		} else { 
		td.html(newtxt); 
		} 
		}); 
}); 


});
function nTabs(thisObj, Num) {
            if (thisObj.className == "active") return;
            var tabList = document.getElementById("myTab").getElementsByTagName("li");
            for (i = 0; i < tabList.length; i++) {
                if (i == Num) {
                    thisObj.className = "active";
                    document.getElementById("tab" + i).style.display = "block";
                } else {
                    tabList[i].className = " ";
                    document.getElementById("tab" + i).style.display = "none";
                }
            }
        }